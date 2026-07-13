#define _GNU_SOURCE

#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>

#ifndef COTTONTAIL_ICU_MIN_VERSION
#define COTTONTAIL_ICU_MIN_VERSION 70
#endif

#ifndef COTTONTAIL_ICU_MAX_VERSION
#define COTTONTAIL_ICU_MAX_VERSION 99
#endif

#define ICU_SYMBOL(name) void* cottontail_icu_target_##name;
#include "icu-symbols.inc"
#undef ICU_SYMBOL

struct ICUEntry {
    const char* name;
    void** target;
};

static struct ICUEntry entries[] = {
#define ICU_SYMBOL(name) { #name, &cottontail_icu_target_##name },
#include "icu-symbols.inc"
#undef ICU_SYMBOL
};

static void fail(const char* message, const char* detail)
{
    fprintf(stderr, "cottontail ICU bridge: %s%s%s\n", message, detail ? ": " : "", detail ? detail : "");
    abort();
}

__attribute__((constructor(101)))
static void initialize(void)
{
    void* common = NULL;
    void* i18n = NULL;
    int version = 0;

    for (int candidate = COTTONTAIL_ICU_MAX_VERSION; candidate >= COTTONTAIL_ICU_MIN_VERSION; --candidate) {
        char commonName[32];
        char i18nName[32];
        snprintf(commonName, sizeof(commonName), "libicuuc.so.%d", candidate);
        snprintf(i18nName, sizeof(i18nName), "libicui18n.so.%d", candidate);

        common = dlopen(commonName, RTLD_NOW | RTLD_LOCAL);
        if (!common)
            continue;

        i18n = dlopen(i18nName, RTLD_NOW | RTLD_LOCAL);
        if (i18n) {
            version = candidate;
            break;
        }

        dlclose(common);
        common = NULL;
    }

    if (!common || !i18n)
        fail("no compatible system ICU installation found (need common and i18n version 70 or newer)", NULL);

    for (size_t i = 0; i < sizeof(entries) / sizeof(entries[0]); ++i) {
        char renamed[128];
        snprintf(renamed, sizeof(renamed), "%s_%d", entries[i].name, version);

        void* symbol = dlsym(i18n, renamed);
        if (!symbol)
            symbol = dlsym(common, renamed);
        if (!symbol)
            symbol = dlsym(i18n, entries[i].name);
        if (!symbol)
            symbol = dlsym(common, entries[i].name);
        if (!symbol)
            fail("system ICU is missing a required stable C API", entries[i].name);

        *entries[i].target = symbol;
    }
}
