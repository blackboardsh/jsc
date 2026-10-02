#define JS_NO_EXPORT 1
#include <JavaScriptCore/JavaScript.h>
#include "cottontail-jsc-embedder.h"
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

extern "C" void JSSynchronousGarbageCollectForDebugging(JSContextRef);

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

static bool exerciseBytecodeLifetime(JSContextRef context)
{
    constexpr size_t literalLength = 256 * 1024;
    std::string code = "globalThis.delayedBytecodeValue = function delayedBytecodeValue() { return '";
    code.append(literalLength, 'x');
    code += "'; }; globalThis.delayedBytecodeError = function delayedBytecodeError() { throw new Error('lazy bytecode error'); };";
    auto source = JSStringCreateWithUTF8CString(code.c_str());
    auto url = JSStringCreateWithUTF8CString("file:///bytecode-lifetime.js");
    std::string().swap(code);
    uint8_t* bytes = nullptr;
    size_t length = 0;
    JSStringRef error = nullptr;
    // Generate in another VM so evaluation must decode the supplied bytecode,
    // rather than reuse an unlinked block already in the target's code cache.
    auto generator = JSGlobalContextCreate(nullptr);
    const int generated = ct_jsc_embedder_bytecode_generate(JSContextGetGroup(generator), source, url, &bytes, &length, &error);
    JSGlobalContextRelease(generator);
    JSValueRef exception = nullptr;
    const int evaluated = generated || !length ? 1 : ct_jsc_embedder_bytecode_evaluate(context, source, url, bytes, length, &exception);
    std::free(bytes);
    JSStringRelease(source);
    JSStringRelease(url);
    if (error) JSStringRelease(error);
    if (evaluated || reportException(context, exception)) return false;

    // No original input buffers remain. First invoke the lazy functions only
    // after the API has returned and a synchronous collection has completed.
    auto check = JSStringCreateWithUTF8CString(R"JS(
        (() => {
            if (delayedBytecodeValue().length !== 262144) throw new Error('lazy literal');
            if (!delayedBytecodeValue.toString().includes('xxxxxxxxxxxxxxxx')) throw new Error('lazy source');
            let caught = false;
            try { delayedBytecodeError(); } catch (error) {
                caught = error.message === 'lazy bytecode error' && String(error.stack).includes('bytecode-lifetime.js');
            }
            if (!caught) throw new Error('lazy exception source');
            return 42;
        })()
    )JS");
    bool passed = true;
    for (unsigned iteration = 0; iteration < 2; ++iteration) {
        JSSynchronousGarbageCollectForDebugging(context);
        auto value = JSEvaluateScript(context, check, nullptr, nullptr, 1, &exception);
        if (reportException(context, exception) || !value || JSValueToNumber(context, value, nullptr) != 42) {
            passed = false;
            break;
        }
    }
    JSStringRelease(check);
    return passed;
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
    if (!exerciseBytecodeLifetime(context)) return 7;
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
