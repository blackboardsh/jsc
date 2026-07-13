#pragma once

#include <algorithm>
#include <iterator>
#include <memory>
#include <unicode/ucal.h>
#include <unicode/udateintervalformat.h>
#include <unicode/uloc.h>
#include <unicode/unumberformatter.h>
#include <unicode/upluralrules.h>
#include <unicode/ures.h>

// Windows exposes ICU's stable C ABI through icu.dll, but its import library
// omits uplrules_selectForRange. Reconstruct that operation from other stable
// C APIs and the same pluralRanges resource used by ICU internally.
static inline int32_t cottontailSelectPluralRange(
    const UPluralRules* pluralRules,
    const UNumberFormatter* numberFormatter,
    const char* locale,
    double start,
    double end,
    UChar* destination,
    int32_t capacity,
    UErrorCode* status)
{
    static constexpr UChar other[] = { 'o', 't', 'h', 'e', 'r' };

    auto copyKeyword = [&](const UChar* keyword, int32_t length) {
        if (!destination ? capacity != 0 : capacity < 0) {
            *status = U_ILLEGAL_ARGUMENT_ERROR;
            return 0;
        }
        if (capacity < length) {
            if (destination && capacity > 0)
                std::copy_n(keyword, capacity, destination);
            *status = U_BUFFER_OVERFLOW_ERROR;
            return length;
        }
        if (destination && length > 0)
            std::copy_n(keyword, length, destination);
        return length;
    };

    auto copyOther = [&] {
        return copyKeyword(other, static_cast<int32_t>(std::size(other)));
    };

    if (U_FAILURE(*status))
        return 0;

    UChar firstKeyword[16];
    UChar secondKeyword[16];

    auto select = [&](double value, UChar* keyword, int32_t keywordCapacity) {
        auto formatted = std::unique_ptr<UFormattedNumber, decltype(&unumf_closeResult)>(
            unumf_openResult(status), &unumf_closeResult);
        if (U_FAILURE(*status))
            return 0;
        unumf_formatDouble(numberFormatter, value, formatted.get(), status);
        if (U_FAILURE(*status))
            return 0;
        return uplrules_selectFormatted(pluralRules, formatted.get(), keyword, keywordCapacity, status);
    };

    int32_t firstLength = select(start, firstKeyword, static_cast<int32_t>(std::size(firstKeyword)));
    int32_t secondLength = select(end, secondKeyword, static_cast<int32_t>(std::size(secondKeyword)));
    if (U_FAILURE(*status))
        return 0;

    char language[ULOC_LANG_CAPACITY];
    uloc_getLanguage(locale, language, static_cast<int32_t>(std::size(language)), status);
    if (U_FAILURE(*status))
        return 0;

    using Resource = std::unique_ptr<UResourceBundle, decltype(&ures_close)>;
    Resource root(ures_openDirect(nullptr, "pluralRanges", status), &ures_close);
    if (U_FAILURE(*status))
        return 0;

    Resource locales(ures_getByKey(root.get(), "locales", nullptr, status), &ures_close);
    Resource rules(ures_getByKey(root.get(), "rules", nullptr, status), &ures_close);
    if (U_FAILURE(*status))
        return 0;

    UErrorCode mappingStatus = U_ZERO_ERROR;
    int32_t ruleSetLength = 0;
    const UChar* ruleSet = ures_getStringByKey(locales.get(), language, &ruleSetLength, &mappingStatus);
    if (U_FAILURE(mappingStatus))
        return copyOther();

    char ruleSetKey[32];
    if (ruleSetLength <= 0 || ruleSetLength >= static_cast<int32_t>(std::size(ruleSetKey)))
        return copyOther();
    for (int32_t i = 0; i < ruleSetLength; ++i)
        ruleSetKey[i] = static_cast<char>(ruleSet[i]);
    ruleSetKey[ruleSetLength] = '\0';

    Resource triples(ures_getByKey(rules.get(), ruleSetKey, nullptr, status), &ures_close);
    if (U_FAILURE(*status))
        return 0;

    auto equals = [](const UChar* left, int32_t leftLength, const UChar* right, int32_t rightLength) {
        return leftLength == rightLength && std::equal(left, left + leftLength, right);
    };

    int32_t tripleCount = ures_getSize(triples.get());
    for (int32_t i = 0; i < tripleCount; ++i) {
        Resource triple(ures_getByIndex(triples.get(), i, nullptr, status), &ures_close);
        if (U_FAILURE(*status))
            return 0;

        int32_t rangeStartLength = 0;
        int32_t rangeEndLength = 0;
        int32_t rangeResultLength = 0;
        const UChar* rangeStart = ures_getStringByIndex(triple.get(), 0, &rangeStartLength, status);
        const UChar* rangeEnd = ures_getStringByIndex(triple.get(), 1, &rangeEndLength, status);
        const UChar* rangeResult = ures_getStringByIndex(triple.get(), 2, &rangeResultLength, status);
        if (U_FAILURE(*status))
            return 0;

        if (equals(firstKeyword, firstLength, rangeStart, rangeStartLength)
            && equals(secondKeyword, secondLength, rangeEnd, rangeEndLength))
            return copyKeyword(rangeResult, rangeResultLength);
    }

    return copyOther();
}

// The calendar overload is absent from Windows' icu.lib. The exported date
// overload is equivalent for dates after the Gregorian reform, which is the
// path WebKit already uses for modern dates.
static inline void cottontailFormatCalendarRange(
    const UDateIntervalFormat* formatter,
    UCalendar* fromCalendar,
    UCalendar* toCalendar,
    UFormattedDateInterval* result,
    UErrorCode* status)
{
    UDate fromDate = ucal_getMillis(fromCalendar, status);
    UDate toDate = ucal_getMillis(toCalendar, status);
    if (U_FAILURE(*status))
        return;
    udtitvfmt_formatToResult(formatter, fromDate, toDate, result, status);
}
