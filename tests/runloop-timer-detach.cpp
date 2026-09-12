#include <wtf/MainThread.h>
#include <wtf/RunLoop.h>
#include <cstdio>
#include <cstdlib>
#include <memory>

using namespace WTF;

class TestTimer final : public RunLoop::TimerBase {
public:
    TestTimer()
        : TimerBase(RunLoop::currentSingleton(), "timer-detach-regression"_s)
    {
    }

    void fired() override { std::abort(); }
};

int main()
{
    initializeMainThread();
    auto parent = std::make_unique<TestTimer>();
    auto child = std::make_unique<TestTimer>();
    parent->startOneShot(Seconds(100));
    child->startOneShot(Seconds(101));

    // Stop both timers while retaining their objects, then destroy the child
    // first. An unpatched libWTF.a leaves its checked pointer in the removed
    // parent task and aborts when that parent is subsequently destroyed.
    // These calls exercise the linked timer implementation, independently of
    // whether the SDK's installed RedBlackTree.h was patched.
    parent->stop();
    child->stop();
    child.reset();
    parent.reset();
    std::puts("PASS: linked RunLoop timers release removed child references");
}
