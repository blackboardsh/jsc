#include <JavaScriptCore/JavaScript.h>
#include <wtf/MainThread.h>
#include <cstdio>
#include <cstring>

// Exported by JSCOnly, but not included in its installed public headers.
extern "C" {
typedef bool (*ShouldTerminateCallback)(JSContextRef, void*);
void JSContextGroupSetExecutionTimeLimit(JSContextGroupRef, double, ShouldTerminateCallback, void*);
void JSContextGroupClearExecutionTimeLimit(JSContextGroupRef);
}

enum class Mode { Continue, Reset, Clear };

struct State {
    Mode mode;
    unsigned callbacks { 0 };
};

static bool shouldTerminate(JSContextRef context, void* opaque)
{
    auto& state = *static_cast<State*>(opaque);
    ++state.callbacks;
    std::printf("watchdog callback %u\n", state.callbacks);
    std::fflush(stdout);
    if (state.mode == Mode::Clear) {
        JSContextGroupClearExecutionTimeLimit(JSContextGetGroup(context));
        return false;
    }
    if (state.mode == Mode::Reset && state.callbacks == 1) {
        JSContextGroupSetExecutionTimeLimit(JSContextGetGroup(context), 0.02, shouldTerminate, opaque);
        return false;
    }
    return state.callbacks >= (state.mode == Mode::Continue ? 3u : 2u);
}

int main(int argc, char** argv)
{
    if (argc != 2 || (std::strcmp(argv[1], "continue") && std::strcmp(argv[1], "reset") && std::strcmp(argv[1], "clear"))) {
        std::fputs("Usage: watchdog-rearm continue|reset|clear\n", stderr);
        return 2;
    }
    State state { !std::strcmp(argv[1], "continue") ? Mode::Continue : !std::strcmp(argv[1], "reset") ? Mode::Reset : Mode::Clear };
    WTF::initializeMainThread();
    auto context = JSGlobalContextCreateInGroup(nullptr, nullptr);
    if (!context) return 3;
    auto group = JSContextGetGroup(context);
    JSContextGroupSetExecutionTimeLimit(group, 0.01, shouldTerminate, &state);
    // Continue/reset must stay in one uninterrupted VM entry. A host polling
    // function would exit/reenter the VM and could accidentally rearm the timer.
    auto source = JSStringCreateWithUTF8CString(state.mode == Mode::Clear
        ? "const until = Date.now() + 250; while (Date.now() < until) {} 42;"
        : "for (;;) {};");
    JSValueRef exception = nullptr;
    auto result = JSEvaluateScript(context, source, nullptr, nullptr, 1, &exception);
    JSStringRelease(source);
    bool passed = state.mode == Mode::Clear
        ? !exception && result && JSValueToNumber(context, result, nullptr) == 42 && state.callbacks == 1
        : exception && state.callbacks == (state.mode == Mode::Continue ? 3u : 2u);
    JSContextGroupClearExecutionTimeLimit(group);
    JSGlobalContextRelease(context);
    if (!passed) {
        std::fprintf(stderr, "FAIL: watchdog %s, callbacks=%u, interrupted=%d\n", argv[1], state.callbacks, exception != nullptr);
        return 1;
    }
    std::printf("PASS: watchdog %s honors callback decisions\n", argv[1]);
}
