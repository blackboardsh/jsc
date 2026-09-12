#include <wtf/RedBlackTree.h>
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>

struct Task final : WTF::RedBlackTree<Task, unsigned>::ThreadSafeNode {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(Task);
    WTF_OVERRIDE_DELETE_FOR_CHECKED_PTR(Task);
public:
    explicit Task(unsigned value) : m_key(value) { }
    unsigned key() const { return m_key; }
    unsigned m_key;
};

static void require(bool value)
{
    if (!value)
        std::abort();
}

int main()
{
    // Match RunLoop's checked-pointer deletion: a retained detached parent must
    // not reference a child removed and destroyed before the parent.
    {
        WTF::RedBlackTree<Task, unsigned> tree;
        auto* parent = new Task(1);
        auto* child = new Task(2);
        tree.insert(parent);
        tree.insert(child);
        require(tree.remove(parent) == parent);
        require(tree.remove(child) == child);
        require(tree.isEmpty());
        std::printf("detached child references: %u\n", child->checkedPtrCount());
        std::fflush(stdout);
        delete child;
        delete parent; // The unpatched tree aborts here in CheckedPtr destruction.
    }

    // Exercise every removal order, including two-child replacement and fixup,
    // and reuse the same nodes after their links have been cleared.
    std::array<unsigned, 5> order { 0, 1, 2, 3, 4 };
    unsigned permutations = 0;
    do {
        WTF::RedBlackTree<Task, unsigned> tree;
        std::array<Task*, 5> tasks;
        for (unsigned index = 0; index < tasks.size(); ++index) {
            tasks[index] = new Task(index);
            tree.insert(tasks[index]);
        }
        for (unsigned round = 0; round < 2; ++round) {
            for (unsigned index : order) {
                auto* task = tasks[index];
                require(tree.remove(task) == task);
                require(!tree.findExact(index));
            }
            require(tree.isEmpty());
            for (auto* task : tasks)
                require(!task->checkedPtrCount());
            if (!round) {
                for (auto* task : tasks)
                    tree.insert(task);
            }
        }
        for (auto* task : tasks)
            delete task;
        ++permutations;
    } while (std::next_permutation(order.begin(), order.end()));
    std::printf("PASS: checked-pointer deletion and %u removal/reinsertion orders\n", permutations);
}
