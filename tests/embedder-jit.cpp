#define JS_NO_EXPORT 1
#include <JavaScriptCore/JavaScript.h>
#include "cottontail-jsc-embedder.h"
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>

static CtJscEncodedValue nativeSum(CtJscInvocation* invocation, void*)
{
    const auto count = ct_jsc_invocation_argument_count(invocation);
    if (count != 12)
        return ct_jsc_throw_type_error(invocation, "expected twelve arguments");
    double sum = 0.5;
    for (size_t index = 0; index < count; ++index)
        sum += ct_jsc_value_to_number(invocation, ct_jsc_invocation_argument(invocation, index));
    return ct_jsc_make_number(invocation, sum);
}

static JSValueRef legacyAnswer(JSContextRef context, JSObjectRef, JSObjectRef, size_t, const JSValueRef[], JSValueRef*)
{
    return JSValueMakeNumber(context, 42);
}

static bool reportException(JSContextRef context, JSValueRef exception)
{
    if (!exception) return false;
    auto text = JSValueToStringCopy(context, exception, nullptr);
    if (text) {
        std::vector<char> message(JSStringGetMaximumUTF8CStringSize(text));
        JSStringGetUTF8CString(text, message.data(), message.size());
        std::fprintf(stderr, "%s\n", message.data());
        JSStringRelease(text);
    }
    return true;
}

static int exerciseContext()
{
    auto context = JSGlobalContextCreate(nullptr);
    if (!context) return 1;
    auto global = JSContextGetGlobalObject(context);
    auto fastName = JSStringCreateWithUTF8CString("nativeSum");
    auto legacyName = JSStringCreateWithUTF8CString("legacyAnswer");
    JSValueRef exception = nullptr;
    auto fast = ct_jsc_embedder_create_function(context, "nativeSum", 12, nativeSum, nullptr);
    auto legacy = ct_jsc_embedder_create_legacy_function(context, "legacyAnswer", 0, legacyAnswer, global);
    JSObjectSetProperty(context, global, fastName, fast, kJSPropertyAttributeNone, &exception);
    JSObjectSetProperty(context, global, legacyName, legacy, kJSPropertyAttributeNone, &exception);
    if (reportException(context, exception)) return 2;

    auto source = JSStringCreateWithUTF8CString(R"JS(
        (() => {
            function hot() { return nativeSum(1,2,3,4,5,6,7,8,9,10,11,12) + legacyAnswer(); }
            for (let index = 0; index < 100000; ++index) {
                if (hot() !== 120.5) throw new Error('native callback result');
            }
            let caught = false;
            try { nativeSum(1); } catch (error) {
                caught = error instanceof TypeError && error.message === 'expected twelve arguments';
            }
            if (!caught) throw new Error('native callback exception');
            if (hot() !== 120.5) throw new Error('callback after exception');
            return 42;
        })()
    )JS");
    auto url = JSStringCreateWithUTF8CString("file:///embedder-jit.js");
    auto value = JSEvaluateScript(context, source, nullptr, url, 1, &exception);
    if (reportException(context, exception) || !value || JSValueToNumber(context, value, nullptr) != 42) return 3;
    JSGarbageCollect(context);

    uint8_t* bytes = nullptr;
    size_t length = 0;
    JSStringRef error = nullptr;
    if (ct_jsc_embedder_bytecode_generate(JSContextGetGroup(context), source, url, &bytes, &length, &error) || !length) return 4;
    const auto result = ct_jsc_embedder_bytecode_evaluate(context, source, url, bytes, length, &exception);
    std::free(bytes);
    if (result || reportException(context, exception)) return 5;
    JSGarbageCollect(context);
    JSStringRelease(fastName);
    JSStringRelease(legacyName);
    JSStringRelease(source);
    JSStringRelease(url);
    JSGlobalContextRelease(context);
    return 0;
}

int main()
{
    if (ct_jsc_embedder_abi_version() != CT_JSC_EMBEDDER_ABI_VERSION) return 6;
    if (const auto result = exerciseContext()) return result;
    int results[2] = {};
    std::thread first([&] { results[0] = exerciseContext(); });
    std::thread second([&] { results[1] = exerciseContext(); });
    first.join();
    second.join();
    if (results[0] || results[1]) return results[0] ? results[0] : results[1];
    std::puts("JSC embedder callbacks, exceptions, bytecode, GC, and concurrent contexts passed");
}
