#ifndef COTTONTAIL_JSC_EMBEDDER_H
#define COTTONTAIL_JSC_EMBEDDER_H

#include <JavaScriptCore/JavaScript.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define CT_JSC_EMBEDDER_ABI_VERSION 2u

typedef uint64_t CtJscEncodedValue;
typedef struct CtJscInvocation CtJscInvocation;

typedef CtJscEncodedValue (*CtJscNativeCallback)(
    CtJscInvocation *invocation,
    void *user_data
);
typedef void (*CtJscFinalizeCallback)(void *user_data);

typedef enum CtJscStringEncoding {
    CT_JSC_STRING_LATIN1 = 1,
    CT_JSC_STRING_UTF16 = 2,
} CtJscStringEncoding;

typedef struct CtJscStringView {
    const void *data;
    size_t length;
    CtJscStringEncoding encoding;
} CtJscStringView;

typedef struct CtJscBytesView {
    const uint8_t *data;
    size_t length;
} CtJscBytesView;

typedef struct CtJscMutableBytesView {
    uint8_t *data;
    size_t length;
} CtJscMutableBytesView;

typedef struct CtJscUtf8View {
    const uint8_t *data;
    size_t length;
} CtJscUtf8View;

uint32_t ct_jsc_embedder_abi_version(void);

int ct_jsc_embedder_bytecode_generate(
    JSContextGroupRef group,
    JSStringRef source,
    JSStringRef source_url,
    uint8_t **output,
    size_t *output_length,
    JSStringRef *error_message
);
int ct_jsc_embedder_bytecode_evaluate(
    JSContextRef context,
    JSStringRef source,
    JSStringRef source_url,
    const uint8_t *bytes,
    size_t length,
    JSValueRef *exception
);

JSObjectRef ct_jsc_embedder_create_function(
    JSContextRef context,
    const char *name,
    unsigned arity,
    CtJscNativeCallback callback,
    void *user_data
);
JSObjectRef ct_jsc_embedder_create_function_with_finalizer(
    JSContextRef context,
    const char *name,
    unsigned arity,
    CtJscNativeCallback callback,
    void *user_data,
    CtJscFinalizeCallback finalize
);
JSObjectRef ct_jsc_embedder_create_legacy_function(
    JSContextRef context,
    const char *name,
    unsigned arity,
    JSObjectCallAsFunctionCallback callback,
    JSObjectRef callback_context
);

size_t ct_jsc_invocation_argument_count(const CtJscInvocation *invocation);
CtJscEncodedValue ct_jsc_invocation_argument(
    const CtJscInvocation *invocation,
    size_t index
);
CtJscEncodedValue ct_jsc_invocation_this(const CtJscInvocation *invocation);
JSContextRef ct_jsc_invocation_context_ref(const CtJscInvocation *invocation);

bool ct_jsc_value_is_undefined(CtJscEncodedValue value);
bool ct_jsc_value_is_null(CtJscEncodedValue value);
bool ct_jsc_value_is_boolean(CtJscEncodedValue value);
bool ct_jsc_value_is_number(CtJscEncodedValue value);
bool ct_jsc_value_is_string(CtJscEncodedValue value);
bool ct_jsc_value_is_object(CtJscEncodedValue value);

bool ct_jsc_value_to_boolean(
    CtJscInvocation *invocation,
    CtJscEncodedValue value
);
double ct_jsc_value_to_number(
    CtJscInvocation *invocation,
    CtJscEncodedValue value
);
int32_t ct_jsc_value_to_int32(
    CtJscInvocation *invocation,
    CtJscEncodedValue value
);
uint32_t ct_jsc_value_to_uint32(
    CtJscInvocation *invocation,
    CtJscEncodedValue value
);

bool ct_jsc_value_get_string_view(
    CtJscInvocation *invocation,
    CtJscEncodedValue value,
    CtJscStringView *result
);
bool ct_jsc_value_to_string_view(
    CtJscInvocation *invocation,
    CtJscEncodedValue value,
    CtJscStringView *result
);
bool ct_jsc_value_get_utf8_view(
    CtJscInvocation *invocation,
    CtJscEncodedValue value,
    CtJscUtf8View *result
);
bool ct_jsc_value_to_utf8_view(
    CtJscInvocation *invocation,
    CtJscEncodedValue value,
    CtJscUtf8View *result
);
bool ct_jsc_value_get_bytes_view(
    CtJscInvocation *invocation,
    CtJscEncodedValue value,
    CtJscBytesView *result
);
JSObjectRef ct_jsc_value_get_object_ref(
    CtJscInvocation *invocation,
    CtJscEncodedValue value
);
JSValueRef ct_jsc_value_get_ref(
    CtJscInvocation *invocation,
    CtJscEncodedValue value
);
CtJscEncodedValue ct_jsc_value_from_ref(
    CtJscInvocation *invocation,
    JSValueRef value
);

CtJscEncodedValue ct_jsc_make_undefined(CtJscInvocation *invocation);
CtJscEncodedValue ct_jsc_make_null(CtJscInvocation *invocation);
CtJscEncodedValue ct_jsc_make_boolean(CtJscInvocation *invocation, bool value);
CtJscEncodedValue ct_jsc_make_number(CtJscInvocation *invocation, double value);
CtJscEncodedValue ct_jsc_make_int32(CtJscInvocation *invocation, int32_t value);
CtJscEncodedValue ct_jsc_make_latin1_string(
    CtJscInvocation *invocation,
    const uint8_t *data,
    size_t length
);
CtJscEncodedValue ct_jsc_make_utf16_string(
    CtJscInvocation *invocation,
    const uint16_t *data,
    size_t length
);
CtJscEncodedValue ct_jsc_make_utf8_string(
    CtJscInvocation *invocation,
    const uint8_t *data,
    size_t length
);
CtJscEncodedValue ct_jsc_make_uint8_array_copy(
    CtJscInvocation *invocation,
    const uint8_t *data,
    size_t length
);
CtJscEncodedValue ct_jsc_make_uint8_array_uninitialized(
    CtJscInvocation *invocation,
    size_t length,
    CtJscMutableBytesView *result
);

CtJscEncodedValue ct_jsc_throw_type_error(
    CtJscInvocation *invocation,
    const char *message
);
CtJscEncodedValue ct_jsc_throw_error(
    CtJscInvocation *invocation,
    const char *message
);
CtJscEncodedValue ct_jsc_throw_value_ref(
    CtJscInvocation *invocation,
    JSValueRef exception
);
bool ct_jsc_invocation_has_exception(const CtJscInvocation *invocation);

#ifdef __cplusplus
}
#endif

#endif
