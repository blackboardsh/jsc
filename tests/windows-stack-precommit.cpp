#define JS_NO_EXPORT 1
#include <JavaScriptCore/JavaScript.h>
#include <windows.h>
#include <process.h>
#include <cstdio>
#include <string>

static constexpr size_t MiB = 1024 * 1024;
static thread_local unsigned reentryCount = 0;

static size_t committedStackBytes()
{
    MEMORY_BASIC_INFORMATION region = {};
    if (!VirtualQuery(&region, &region, sizeof(region)))
        return 0;
    const void* allocation = region.AllocationBase;
    auto* cursor = static_cast<unsigned char*>(region.AllocationBase);
    size_t committed = 0;
    while (VirtualQuery(cursor, &region, sizeof(region)) && region.AllocationBase == allocation) {
        if (region.State == MEM_COMMIT)
            committed += region.RegionSize;
        cursor += region.RegionSize;
    }
    return committed;
}

static bool checkStack(size_t reservation, const char* stage)
{
    const size_t committed = committedStackBytes();
    std::printf("stack reserve=%zu committed=%zu stage=%s\n", reservation, committed, stage);
    if (!committed)
        return false;
    // A large reserve must remain mostly virtual, including after releasing the
    // JSLock. Allow ample space beyond JSC's default 5 MiB active stack budget.
    if (reservation >= 32 * MiB && committed > 8 * MiB) {
        std::fprintf(stderr, "Inactive VM precommitted the stack reservation at %s\n", stage);
        return false;
    }
    // On a small stack the active and inactive limits coincide. Checking this
    // before JS evaluation catches a patch that skips the first active precommit
    // merely because the computed limit did not change during lock acquisition.
    if (reservation == MiB && committed < reservation - 256 * 1024) {
        std::fprintf(stderr, "Small stack was not precommitted before JS execution at %s\n", stage);
        return false;
    }
    return true;
}

static JSValueRef reenter(JSContextRef context, JSObjectRef, JSObjectRef, size_t,
    const JSValueRef[], JSValueRef* exception)
{
    auto source = JSStringCreateWithUTF8CString("(() => 40 + 2)()");
    auto result = JSEvaluateScript(context, source, nullptr, nullptr, 1, exception);
    JSStringRelease(source);
    if (result && (!exception || !*exception) && JSValueToNumber(context, result, nullptr) == 42)
        ++reentryCount;
    return result;
}

static bool evaluate(JSGlobalContextRef context, const std::string& source)
{
    auto script = JSStringCreateWithUTF8CString(source.c_str());
    JSValueRef exception = nullptr;
    auto value = JSEvaluateScript(context, script, nullptr, nullptr, 1, &exception);
    JSStringRelease(script);
    if (exception || !value || JSValueToNumber(context, value, nullptr) != 42) {
        std::fprintf(stderr, "Stack regression JavaScript failed\n");
        return false;
    }
    return true;
}

static bool drainPromiseOnUnlock(JSGlobalContextRef context)
{
    auto script = JSStringCreateWithUTF8CString("Promise.resolve().then(() => reenter()); 42");
    JSValueRef exception = nullptr;
    const auto before = reentryCount;
    auto value = JSEvaluateScript(context, script, nullptr, nullptr, 1, &exception);
    // Check before making any further context API call: the Promise must run
    // during the outer API lock's release, while its entry stack limit is valid.
    const bool drained = reentryCount == before + 1;
    JSStringRelease(script);
    if (!drained || exception || !value) {
        std::fprintf(stderr, "Promise callback did not reenter JS during outer unlock\n");
        return false;
    }
    return true;
}

struct ThreadCase {
    size_t reservation;
    unsigned result = 1;
    JSGlobalContextRef retainedContext = nullptr;
    bool retainContext = false;
};

static unsigned __stdcall exerciseStack(void* argument)
{
    auto& test = *static_cast<ThreadCase*>(argument);
    // Recreating the context also checks a temporary VM followed by an app VM
    // on the same thread, as used by Cottontail's bytecode generation path.
    const unsigned iterations = test.retainContext || test.retainedContext ? 1 : 2;
    for (unsigned iteration = 0; iteration < iterations; ++iteration) {
        auto context = test.retainedContext;
        if (context) {
            // This context came from a now-exited thread with a larger stack.
            // Enter it on the new thread before measuring its committed pages.
            if (!evaluate(context, "globalThis.migratingAnswer"))
                return test.result;
        } else
            context = JSGlobalContextCreateInGroup(nullptr, nullptr);
        if (!context || !checkStack(test.reservation, "context-created"))
            return test.result;
        auto name = JSStringCreateWithUTF8CString("reenter");
        auto callback = JSObjectMakeFunctionWithCallback(context, name, reenter);
        JSObjectSetProperty(context, JSContextGetGlobalObject(context), name, callback,
            kJSPropertyAttributeNone, nullptr);
        JSStringRelease(name);

        // The first invocation has a frame larger than a guard page. Follow it
        // with repeated calls, native-to-JS reentry, and a non-tail recursion overflow.
        std::string source = "(() => { function wide(x) {";
        for (unsigned index = 0; index < 2048; ++index)
            source += "let v" + std::to_string(index) + "=x+" + std::to_string(index) + ";";
        source += "let total=0;";
        for (unsigned index = 0; index < 2048; ++index)
            source += "total+=v" + std::to_string(index) + ";";
        source += "return total; } for(let i=0;i<4;++i) {"
                  "if(wide(i)!==2048*i+2096128) throw new Error('wide frame'); }"
                  "if(reenter()!==42) throw new Error('reentry');"
                  "function recurse(n) { return 1+recurse(n+1); }"
                  "let caught=false; try { recurse(0); } catch(e) { caught=e instanceof RangeError; }"
                  "if(!caught) throw new Error('missing stack overflow'); return reenter(); })()";
        if (!evaluate(context, source) || !drainPromiseOnUnlock(context)
            || !checkStack(test.reservation, "after-evaluation"))
            return test.result;
        JSGarbageCollect(context);
        if (test.retainContext) {
            if (!evaluate(context, "globalThis.migratingAnswer = 42"))
                return test.result;
            test.retainedContext = context;
            continue;
        }
        JSGlobalContextRelease(context);
        test.retainedContext = nullptr;
        if (!checkStack(test.reservation, "context-released"))
            return test.result;
    }
    test.result = 0;
    return 0;
}

static bool runCase(ThreadCase& test)
{
    test.result = 1;
    auto handle = reinterpret_cast<HANDLE>(_beginthreadex(nullptr,
        static_cast<unsigned>(test.reservation), exerciseStack, &test,
        STACK_SIZE_PARAM_IS_A_RESERVATION, nullptr));
    if (!handle) {
        std::fprintf(stderr, "Could not create stack regression thread\n");
        return false;
    }
    const auto wait = WaitForSingleObject(handle, 30000);
    CloseHandle(handle);
    return wait == WAIT_OBJECT_0 && !test.result;
}

int main()
{
    for (size_t reservation : { 128 * MiB, 32 * MiB, MiB }) {
        ThreadCase test { reservation };
        if (!runCase(test))
            return 1;
    }
    ThreadCase migration { 128 * MiB };
    migration.retainContext = true;
    if (!runCase(migration))
        return 1;
    migration.reservation = MiB;
    migration.retainContext = false;
    if (!runCase(migration))
        return 1;
    std::puts("Context migration and Promise callback during unlock passed");
    std::puts("Windows active stack precommit, small stacks, recursion, and reentry passed");
}
