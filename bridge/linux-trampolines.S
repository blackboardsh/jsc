#if !defined(__x86_64__) && !defined(__aarch64__)
#error "The Cottontail ICU bridge supports x86_64 and aarch64 Linux"
#endif

    .text

#if defined(__x86_64__)
#define ICU_SYMBOL(name) \
    .globl name; \
    .type name, @function; \
name:; \
    jmp *cottontail_icu_target_##name(%rip); \
    .size name, .-name;
#else
#define ICU_SYMBOL(name) \
    .globl name; \
    .type name, %function; \
name:; \
    adrp x16, cottontail_icu_target_##name; \
    ldr x16, [x16, :lo12:cottontail_icu_target_##name]; \
    br x16; \
    .size name, .-name;
#endif

#include "icu-symbols.inc"

#undef ICU_SYMBOL

#if defined(__linux__)
    .section .note.GNU-stack,"",@progbits
#endif
