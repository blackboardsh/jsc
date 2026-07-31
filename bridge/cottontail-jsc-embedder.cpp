#include "config.h"
#include "cottontail-jsc-embedder.h"

#include <JavaScriptCore/APICast.h>
#include <JavaScriptCore/ArrayBuffer.h>
#include <JavaScriptCore/BytecodeCacheError.h>
#include <JavaScriptCore/CallFrame.h>
#include <JavaScriptCore/CachedBytecode.h>
#include <JavaScriptCore/Completion.h>
#include <JavaScriptCore/Error.h>
#include <JavaScriptCore/Exception.h>
#include <JavaScriptCore/JSArrayBuffer.h>
#include <JavaScriptCore/JSArrayBufferView.h>
#include <JavaScriptCore/JSGenericTypedArrayViewInlines.h>
#include <JavaScriptCore/JSGlobalObject.h>
#include <JavaScriptCore/JSCJSValueInlines.h>
#include <JavaScriptCore/JSLock.h>
#include "JSFunctionWithFields.h"
#include <JavaScriptCore/JSNativeStdFunction.h>
#include <JavaScriptCore/JSCBytecodeCacheVersion.h>
#include <JavaScriptCore/JSString.h>
#include <JavaScriptCore/JSTypedArrays.h>
#include <JavaScriptCore/OpaqueJSString.h>
#include <JavaScriptCore/SourceCode.h>
#include <JavaScriptCore/SourceOrigin.h>
#include <JavaScriptCore/SourceProvider.h>
#include <JavaScriptCore/ThrowScope.h>
#include <JavaScriptCore/TypedArrayType.h>
#include <algorithm>
#include <array>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <optional>
#include <span>
#include <type_traits>
#include <utility>
#include <wtf/Vector.h>
#include <wtf/FileSystem.h>
#include <wtf/FileHandle.h>
#include <wtf/MallocSpan.h>
#include <wtf/URL.h>
#include <wtf/text/CString.h>
#include <wtf/text/StringImpl.h>
#include <wtf/text/WTFString.h>

struct CtJscInvocation {
    JSC::JSGlobalObject *global_object;
    JSC::CallFrame *call_frame;
    std::optional<WTF::Vector<WTF::String, 4>> pinned_strings;
    std::optional<WTF::Vector<WTF::CString, 4>> pinned_utf8;
};

static JSC::JSValue ct_decode(CtJscEncodedValue value)
{
    return JSC::JSValue::decode(static_cast<JSC::EncodedJSValue>(value));
}

static CtJscEncodedValue ct_encode(JSC::JSValue value)
{
    return static_cast<CtJscEncodedValue>(JSC::JSValue::encode(value));
}

static WTF::String ct_message(const char *message)
{
    if (!message)
        return { };
    return WTF::String::fromUTF8ReplacingInvalidSequences(
        std::span(reinterpret_cast<const char8_t *>(message), std::strlen(message)));
}

extern "C" uint32_t ct_jsc_embedder_abi_version(void)
{
    return CT_JSC_EMBEDDER_ABI_VERSION;
}

namespace {

constexpr std::array<uint8_t, 8> bytecode_magic { 'C', 'T', 'J', 'S', 'C', 'B', '0', '2' };
constexpr uint32_t bytecode_schema = 2;
constexpr size_t bytecode_header_size = 56;
constexpr uint64_t fnv_offset = UINT64_C(14695981039346656037);
constexpr uint64_t fnv_prime = UINT64_C(1099511628211);

class CtCachedSourceProvider final : public JSC::SourceProvider {
public:
    static WTF::Ref<CtCachedSourceProvider> create(
        const JSC::SourceOrigin &origin,
        WTF::String source_url,
        const WTF::String &source,
        JSC::CachedBytecode *cached_bytecode = nullptr)
    {
        return WTF::adoptRef(*new CtCachedSourceProvider(
            origin,
            std::move(source_url),
            source,
            cached_bytecode));
    }

    unsigned hash() const final { return m_source.get().hash(); }
    WTF::StringView source() const final { return m_source.get(); }
    WTF::RefPtr<JSC::CachedBytecode> cachedBytecode() const final
    {
        return m_cached_bytecode;
    }

private:
    CtCachedSourceProvider(
        const JSC::SourceOrigin &origin,
        WTF::String &&source_url,
        const WTF::String &source,
        JSC::CachedBytecode *cached_bytecode)
        : JSC::SourceProvider(
            origin,
            std::move(source_url),
            { },
            JSC::SourceTaintedOrigin::Untainted,
            { },
            JSC::SourceProviderSourceType::Program)
        , m_source(source.isNull() ? *WTF::StringImpl::empty() : *source.impl())
        , m_cached_bytecode(cached_bytecode)
    {
    }

    ~CtCachedSourceProvider() final = default;

    const WTF::Ref<WTF::StringImpl> m_source;
    WTF::RefPtr<JSC::CachedBytecode> m_cached_bytecode;
};

uint64_t ct_hash_bytes(std::span<const uint8_t> bytes)
{
    uint64_t hash = fnv_offset;
    for (uint8_t byte : bytes) {
        hash ^= byte;
        hash *= fnv_prime;
    }
    return hash;
}

uint64_t ct_hash_string(JSStringRef string)
{
    uint64_t hash = fnv_offset;
    const size_t length = string ? JSStringGetLength(string) : 0;
    const JSChar *characters = string ? JSStringGetCharactersPtr(string) : nullptr;
    for (size_t index = 0; index < length; ++index) {
        const uint16_t character = characters[index];
        hash ^= static_cast<uint8_t>(character);
        hash *= fnv_prime;
        hash ^= static_cast<uint8_t>(character >> 8);
        hash *= fnv_prime;
    }
    for (unsigned shift = 0; shift < 64; shift += 8) {
        hash ^= static_cast<uint8_t>(length >> shift);
        hash *= fnv_prime;
    }
    return hash;
}

uint64_t ct_bytecode_engine_identity()
{
    return (static_cast<uint64_t>(JSC::computeJSCBytecodeCacheVersion()) << 32)
        | CT_JSC_EMBEDDER_ABI_VERSION;
}

void ct_write_u32(uint8_t *output, uint32_t value)
{
    for (unsigned index = 0; index < 4; ++index)
        output[index] = static_cast<uint8_t>(value >> (index * 8));
}

void ct_write_u64(uint8_t *output, uint64_t value)
{
    for (unsigned index = 0; index < 8; ++index)
        output[index] = static_cast<uint8_t>(value >> (index * 8));
}

uint32_t ct_read_u32(const uint8_t *input)
{
    uint32_t value = 0;
    for (unsigned index = 0; index < 4; ++index)
        value |= static_cast<uint32_t>(input[index]) << (index * 8);
    return value;
}

uint64_t ct_read_u64(const uint8_t *input)
{
    uint64_t value = 0;
    for (unsigned index = 0; index < 8; ++index)
        value |= static_cast<uint64_t>(input[index]) << (index * 8);
    return value;
}

bool ct_unpack_bytecode(
    JSStringRef source,
    JSStringRef source_url,
    const uint8_t *bytes,
    size_t length,
    std::span<const uint8_t> &payload)
{
    if (!bytes || length < bytecode_header_size)
        return false;
    if (!std::equal(bytecode_magic.begin(), bytecode_magic.end(), bytes))
        return false;
    if (ct_read_u32(bytes + 8) != bytecode_schema
        || ct_read_u32(bytes + 12) != bytecode_header_size)
        return false;
    if (ct_read_u64(bytes + 16) != ct_bytecode_engine_identity())
        return false;
    if (ct_read_u64(bytes + 24) != ct_hash_string(source)
        || ct_read_u64(bytes + 32) != ct_hash_string(source_url))
        return false;

    const uint64_t payload_length_64 = ct_read_u64(bytes + 48);
    if (payload_length_64 > std::numeric_limits<size_t>::max())
        return false;
    const size_t payload_length = static_cast<size_t>(payload_length_64);
    if (!payload_length || payload_length > length - bytecode_header_size)
        return false;
    if (bytecode_header_size + payload_length != length)
        return false;
    payload = { bytes + bytecode_header_size, payload_length };
    return ct_read_u64(bytes + 40) == ct_hash_bytes(payload);
}

} // namespace

extern "C" int ct_jsc_embedder_bytecode_generate(
    JSContextGroupRef group,
    JSStringRef source,
    JSStringRef source_url,
    uint8_t **output,
    size_t *output_length,
    JSStringRef *error_message)
{
    if (output)
        *output = nullptr;
    if (output_length)
        *output_length = 0;
    if (error_message)
        *error_message = nullptr;
    if (!group || !source || !source_url || !output || !output_length)
        return -1;

    auto &vm = *toJS(group);
    JSC::JSLockHolder lock(vm);
    WTF::String source_string = const_cast<OpaqueJSString *>(source)->string();
    WTF::String source_url_string = const_cast<OpaqueJSString *>(source_url)->string();
    WTF::URL parsed_source_url { WTF::URL(), source_url_string };
    JSC::SourceOrigin origin(parsed_source_url);
    auto provider = CtCachedSourceProvider::create(
        origin,
        parsed_source_url.string(),
        source_string);
    JSC::SourceCode source_code(provider.copyRef());
    FileSystem::FileHandle invalid_file;
    JSC::BytecodeCacheError cache_error;
    WTF::RefPtr<JSC::CachedBytecode> cached = JSC::generateProgramBytecode(
        vm,
        source_code,
        invalid_file,
        cache_error);
    if (!cached) {
        if (error_message && cache_error.isValid()) {
            auto message = cache_error.message().utf8();
            *error_message = JSStringCreateWithUTF8CString(message.data());
        }
        return -1;
    }

    const std::span<const uint8_t> payload = cached->span();
    if (payload.empty()
        || payload.size() > std::numeric_limits<size_t>::max() - bytecode_header_size)
        return -1;
    const size_t result_length = bytecode_header_size + payload.size();
    auto *result = static_cast<uint8_t *>(std::malloc(result_length));
    if (!result)
        return -1;

    std::copy(bytecode_magic.begin(), bytecode_magic.end(), result);
    ct_write_u32(result + 8, bytecode_schema);
    ct_write_u32(result + 12, bytecode_header_size);
    ct_write_u64(result + 16, ct_bytecode_engine_identity());
    ct_write_u64(result + 24, ct_hash_string(source));
    ct_write_u64(result + 32, ct_hash_string(source_url));
    ct_write_u64(result + 40, ct_hash_bytes(payload));
    ct_write_u64(result + 48, payload.size());
    std::memcpy(result + bytecode_header_size, payload.data(), payload.size());
    *output = result;
    *output_length = result_length;
    return 0;
}

extern "C" int ct_jsc_embedder_bytecode_evaluate(
    JSContextRef context,
    JSStringRef source,
    JSStringRef source_url,
    const uint8_t *bytes,
    size_t length,
    JSValueRef *exception)
{
    if (exception)
        *exception = nullptr;
    if (!context || !source || !source_url)
        return 1;

    auto *global_object = toJS(context);
    auto &vm = global_object->vm();
    JSC::JSLockHolder lock(vm);
    std::span<const uint8_t> payload;
    if (!ct_unpack_bytecode(source, source_url, bytes, length, payload))
        return 1;

    auto allocation = WTF::MallocSpan<uint8_t, JSC::VMMalloc>::tryMalloc(payload.size());
    if (!allocation)
        return 1;
    std::memcpy(allocation.mutableSpan().data(), payload.data(), payload.size());
    auto cached = JSC::CachedBytecode::create(std::move(allocation), { });

    WTF::String source_string = const_cast<OpaqueJSString *>(source)->string();
    WTF::String source_url_string = const_cast<OpaqueJSString *>(source_url)->string();
    WTF::URL parsed_source_url { WTF::URL(), source_url_string };
    JSC::SourceOrigin origin(parsed_source_url);
    auto provider = CtCachedSourceProvider::create(
        origin,
        parsed_source_url.string(),
        source_string,
        cached.ptr());
    JSC::SourceCode source_code(provider.copyRef());
    WTF::NakedPtr<JSC::Exception> internal_exception;
    JSC::evaluate(global_object, source_code, JSC::jsUndefined(), internal_exception);
    if (internal_exception) {
        if (exception)
            *exception = toRef(global_object, internal_exception->value());
        return 0;
    }
    return 0;
}

namespace {

struct CtJscFunctionState {
    CtJscNativeCallback callback;
    void *user_data;
};

struct CtJscLegacyFunctionState {
    JSObjectCallAsFunctionCallback callback;
    JSObjectRef callback_context;
};

template<typename State>
State ct_jsc_function_state(JSC::CallFrame *call_frame)
{
    static_assert(std::is_trivially_copyable_v<State>);
    auto *function = JSC::jsCast<JSC::JSFunctionWithFields *>(call_frame->jsCallee());
    auto *storage = JSC::jsCast<JSC::JSArrayBuffer *>(
        function->getField(JSC::JSFunctionWithFields::Field::ExecutorResolve));
    RELEASE_ASSERT(storage->impl()->byteLength() == sizeof(State));
    State state;
    std::memcpy(&state, storage->impl()->data(), sizeof(state));
    return state;
}

JSC_DECLARE_HOST_FUNCTION(ct_jsc_direct_function_call);
JSC_DEFINE_HOST_FUNCTION(
    ct_jsc_direct_function_call,
    (JSC::JSGlobalObject *global, JSC::CallFrame *frame))
{
    const auto state = ct_jsc_function_state<CtJscFunctionState>(frame);
    CtJscInvocation invocation { global, frame, std::nullopt, std::nullopt };
    return static_cast<JSC::EncodedJSValue>(state.callback(&invocation, state.user_data));
}

JSC_DECLARE_HOST_FUNCTION(ct_jsc_direct_legacy_function_call);
JSC_DEFINE_HOST_FUNCTION(
    ct_jsc_direct_legacy_function_call,
    (JSC::JSGlobalObject *global, JSC::CallFrame *frame))
{
    const auto state = ct_jsc_function_state<CtJscLegacyFunctionState>(frame);
    auto scope = DECLARE_THROW_SCOPE(global->vm());
    WTF::Vector<JSValueRef, 8> arguments;
    arguments.reserveInitialCapacity(frame->argumentCount());
    for (size_t index = 0; index < frame->argumentCount(); index += 1)
        arguments.append(toRef(global, frame->uncheckedArgument(index)));

    JSValueRef exception = nullptr;
    JSValueRef result = state.callback(
        reinterpret_cast<JSContextRef>(global),
        state.callback_context,
        frame->thisValue().isObject()
            ? toRef(frame->thisValue().getObject())
            : state.callback_context,
        arguments.size(),
        arguments.span().data(),
        &exception);
    if (exception) {
        JSC::throwException(global, scope, toJS(global, exception));
        return JSC::JSValue::encode(JSC::jsUndefined());
    }
    if (!result)
        return JSC::JSValue::encode(JSC::jsUndefined());
    return JSC::JSValue::encode(toJS(global, result));
}

template<typename State>
JSObjectRef ct_jsc_create_direct_function(
    JSC::JSGlobalObject *global_object,
    unsigned arity,
    const WTF::String &function_name,
    JSC::NativeFunction native_function,
    const State &state)
{
    static_assert(std::is_trivially_copyable_v<State>);
    auto &vm = global_object->vm();
    auto state_buffer = JSC::ArrayBuffer::tryCreate(std::span(
        reinterpret_cast<const uint8_t *>(&state),
        sizeof(state)));
    if (!state_buffer)
        return nullptr;

    auto *storage = JSC::JSArrayBuffer::create(
        vm,
        global_object->arrayBufferStructure(JSC::ArrayBufferSharingMode::Default),
        std::move(state_buffer));
    auto *executable = vm.getHostFunction(
        native_function,
        JSC::ImplementationVisibility::Private,
        JSC::callHostFunctionAsConstructor,
        function_name);
    auto *function = JSC::JSFunctionWithFields::create(
        vm,
        global_object,
        executable,
        arity,
        function_name);
    function->setField(
        vm,
        JSC::JSFunctionWithFields::Field::ExecutorResolve,
        storage);
    return toRef(function);
}

} // namespace

extern "C" JSObjectRef ct_jsc_embedder_create_function(
    JSContextRef context,
    const char *name,
    unsigned arity,
    CtJscNativeCallback callback,
    void *user_data)
{
    if (!context || !callback)
        return nullptr;

    auto *global_object = toJS(context);
    auto &vm = global_object->vm();
    JSC::JSLockHolder lock(vm);
    WTF::String function_name = name
        ? WTF::String::fromUTF8ReplacingInvalidSequences(
            std::span(reinterpret_cast<const char8_t *>(name), std::strlen(name)))
        : WTF::String();

    const CtJscFunctionState state { callback, user_data };
    return ct_jsc_create_direct_function(
        global_object,
        arity,
        function_name,
        ct_jsc_direct_function_call,
        state);
}

extern "C" JSObjectRef ct_jsc_embedder_create_function_with_finalizer(
    JSContextRef context,
    const char *name,
    unsigned arity,
    CtJscNativeCallback callback,
    void *user_data,
    CtJscFinalizeCallback finalize)
{
    if (!context || !callback || !finalize)
        return nullptr;

    auto *global_object = toJS(context);
    auto &vm = global_object->vm();
    JSC::JSLockHolder lock(vm);
    WTF::String function_name = name
        ? WTF::String::fromUTF8ReplacingInvalidSequences(
            std::span(reinterpret_cast<const char8_t *>(name), std::strlen(name)))
        : WTF::String();
    std::shared_ptr<void> state(user_data, finalize);

    JSC::NativeStdFunction function(
        [callback, state = std::move(state)](JSC::JSGlobalObject *global, JSC::CallFrame *frame) {
            CtJscInvocation invocation { global, frame, std::nullopt, std::nullopt };
            return static_cast<JSC::EncodedJSValue>(callback(&invocation, state.get()));
        });
    return toRef(JSC::JSNativeStdFunction::create(
        vm,
        global_object,
        arity,
        function_name,
        std::move(function)));
}

extern "C" JSObjectRef ct_jsc_embedder_create_legacy_function(
    JSContextRef context,
    const char *name,
    unsigned arity,
    JSObjectCallAsFunctionCallback callback,
    JSObjectRef callback_context)
{
    if (!context || !callback || !callback_context)
        return nullptr;

    auto *global_object = toJS(context);
    auto &vm = global_object->vm();
    JSC::JSLockHolder lock(vm);
    WTF::String function_name = name
        ? WTF::String::fromUTF8ReplacingInvalidSequences(
            std::span(reinterpret_cast<const char8_t *>(name), std::strlen(name)))
        : WTF::String();

    const CtJscLegacyFunctionState state { callback, callback_context };
    return ct_jsc_create_direct_function(
        global_object,
        arity,
        function_name,
        ct_jsc_direct_legacy_function_call,
        state);
}

extern "C" size_t ct_jsc_invocation_argument_count(const CtJscInvocation *invocation)
{
    return invocation && invocation->call_frame
        ? invocation->call_frame->argumentCount()
        : 0;
}

extern "C" CtJscEncodedValue ct_jsc_invocation_argument(
    const CtJscInvocation *invocation,
    size_t index)
{
    if (!invocation || !invocation->call_frame)
        return ct_encode(JSC::jsUndefined());
    return ct_encode(invocation->call_frame->argument(index));
}

extern "C" CtJscEncodedValue ct_jsc_invocation_this(const CtJscInvocation *invocation)
{
    if (!invocation || !invocation->call_frame)
        return ct_encode(JSC::jsUndefined());
    return ct_encode(invocation->call_frame->thisValue());
}

extern "C" JSContextRef ct_jsc_invocation_context_ref(const CtJscInvocation *invocation)
{
    return invocation && invocation->global_object
        ? reinterpret_cast<JSContextRef>(invocation->global_object)
        : nullptr;
}

extern "C" bool ct_jsc_value_is_undefined(CtJscEncodedValue value)
{
    return ct_decode(value).isUndefined();
}

extern "C" bool ct_jsc_value_is_null(CtJscEncodedValue value)
{
    return ct_decode(value).isNull();
}

extern "C" bool ct_jsc_value_is_boolean(CtJscEncodedValue value)
{
    return ct_decode(value).isBoolean();
}

extern "C" bool ct_jsc_value_is_number(CtJscEncodedValue value)
{
    return ct_decode(value).isNumber();
}

extern "C" bool ct_jsc_value_is_string(CtJscEncodedValue value)
{
    return ct_decode(value).isString();
}

extern "C" bool ct_jsc_value_is_object(CtJscEncodedValue value)
{
    return ct_decode(value).isObject();
}

extern "C" bool ct_jsc_value_to_boolean(
    CtJscInvocation *invocation,
    CtJscEncodedValue value)
{
    return invocation && invocation->global_object
        ? ct_decode(value).toBoolean(invocation->global_object)
        : false;
}

extern "C" double ct_jsc_value_to_number(
    CtJscInvocation *invocation,
    CtJscEncodedValue value)
{
    return invocation && invocation->global_object
        ? ct_decode(value).toNumber(invocation->global_object)
        : 0;
}

extern "C" int32_t ct_jsc_value_to_int32(
    CtJscInvocation *invocation,
    CtJscEncodedValue value)
{
    return invocation && invocation->global_object
        ? ct_decode(value).toInt32(invocation->global_object)
        : 0;
}

extern "C" uint32_t ct_jsc_value_to_uint32(
    CtJscInvocation *invocation,
    CtJscEncodedValue value)
{
    return invocation && invocation->global_object
        ? ct_decode(value).toUInt32(invocation->global_object)
        : 0;
}

static bool ct_string_view(
    CtJscInvocation *invocation,
    JSC::JSValue value,
    bool coerce,
    CtJscStringView *result)
{
    if (!invocation || !invocation->global_object || !result)
        return false;

    JSC::JSString *string = coerce
        ? value.toStringOrNull(invocation->global_object)
        : (value.isString() ? JSC::asString(value) : nullptr);
    if (!string)
        return false;

    auto scoped = string->value(invocation->global_object);
    if (invocation->global_object->vm().exceptionForInspection())
        return false;
    if (!invocation->pinned_strings)
        invocation->pinned_strings.emplace();
    invocation->pinned_strings->append(static_cast<const WTF::String &>(scoped));
    const auto &pinned = invocation->pinned_strings->last();
    result->length = pinned.length();
    if (pinned.is8Bit()) {
        auto bytes = pinned.span8();
        result->data = bytes.data();
        result->encoding = CT_JSC_STRING_LATIN1;
    } else {
        auto characters = pinned.span16();
        result->data = characters.data();
        result->encoding = CT_JSC_STRING_UTF16;
    }
    return true;
}

extern "C" bool ct_jsc_value_get_string_view(
    CtJscInvocation *invocation,
    CtJscEncodedValue value,
    CtJscStringView *result)
{
    return ct_string_view(invocation, ct_decode(value), false, result);
}

extern "C" bool ct_jsc_value_to_string_view(
    CtJscInvocation *invocation,
    CtJscEncodedValue value,
    CtJscStringView *result)
{
    return ct_string_view(invocation, ct_decode(value), true, result);
}

static bool ct_utf8_view(
    CtJscInvocation *invocation,
    JSC::JSValue value,
    bool coerce,
    CtJscUtf8View *result)
{
    if (!result)
        return false;

    CtJscStringView string_view;
    if (!ct_string_view(invocation, value, coerce, &string_view))
        return false;

    if (string_view.encoding == CT_JSC_STRING_LATIN1) {
        auto bytes = std::span(
            static_cast<const uint8_t *>(string_view.data),
            string_view.length);
        bool ascii = true;
        for (uint8_t byte : bytes) {
            if (byte & 0x80) {
                ascii = false;
                break;
            }
        }
        if (ascii) {
            result->data = bytes.data();
            result->length = bytes.size();
            return true;
        }
    }

    if (!invocation->pinned_utf8)
        invocation->pinned_utf8.emplace();
    invocation->pinned_utf8->append(invocation->pinned_strings->last().utf8());
    const auto &utf8 = invocation->pinned_utf8->last();
    result->data = reinterpret_cast<const uint8_t *>(utf8.data());
    result->length = utf8.length();
    return true;
}

extern "C" bool ct_jsc_value_get_utf8_view(
    CtJscInvocation *invocation,
    CtJscEncodedValue value,
    CtJscUtf8View *result)
{
    return ct_utf8_view(invocation, ct_decode(value), false, result);
}

extern "C" bool ct_jsc_value_to_utf8_view(
    CtJscInvocation *invocation,
    CtJscEncodedValue value,
    CtJscUtf8View *result)
{
    return ct_utf8_view(invocation, ct_decode(value), true, result);
}

extern "C" bool ct_jsc_value_get_bytes_view(
    CtJscInvocation *invocation,
    CtJscEncodedValue encoded,
    CtJscBytesView *result)
{
    if (!invocation || !invocation->global_object || !result)
        return false;
    auto value = ct_decode(encoded);
    if (!value.isObject())
        return false;
    auto *object = value.getObject();
    if (auto *view = JSC::jsDynamicCast<JSC::JSArrayBufferView *>(object)) {
        if (view->isDetached() || view->isOutOfBounds())
            return false;
        result->data = static_cast<const uint8_t *>(view->vector());
        result->length = view->byteLength();
        return true;
    }
    if (auto *buffer = JSC::jsDynamicCast<JSC::JSArrayBuffer *>(object)) {
        auto *impl = buffer->impl();
        if (!impl || impl->isDetached())
            return false;
        result->data = static_cast<const uint8_t *>(impl->data());
        result->length = impl->byteLength();
        return true;
    }
    return false;
}

extern "C" JSObjectRef ct_jsc_value_get_object_ref(
    CtJscInvocation *invocation,
    CtJscEncodedValue encoded)
{
    if (!invocation || !invocation->global_object)
        return nullptr;
    auto value = ct_decode(encoded);
    return value.isObject() ? toRef(value.getObject()) : nullptr;
}

extern "C" JSValueRef ct_jsc_value_get_ref(
    CtJscInvocation *invocation,
    CtJscEncodedValue encoded)
{
    if (!invocation || !invocation->global_object)
        return nullptr;
    return toRef(invocation->global_object, ct_decode(encoded));
}

extern "C" CtJscEncodedValue ct_jsc_value_from_ref(
    CtJscInvocation *invocation,
    JSValueRef value)
{
    if (!invocation || !invocation->global_object || !value)
        return ct_encode(JSC::jsUndefined());
    return ct_encode(toJS(invocation->global_object, value));
}

extern "C" CtJscEncodedValue ct_jsc_make_undefined(CtJscInvocation *)
{
    return ct_encode(JSC::jsUndefined());
}

extern "C" CtJscEncodedValue ct_jsc_make_null(CtJscInvocation *)
{
    return ct_encode(JSC::jsNull());
}

extern "C" CtJscEncodedValue ct_jsc_make_boolean(CtJscInvocation *, bool value)
{
    return ct_encode(JSC::jsBoolean(value));
}

extern "C" CtJscEncodedValue ct_jsc_make_number(CtJscInvocation *, double value)
{
    return ct_encode(JSC::JSValue(value));
}

extern "C" CtJscEncodedValue ct_jsc_make_int32(CtJscInvocation *, int32_t value)
{
    return ct_encode(JSC::JSValue(value));
}

extern "C" CtJscEncodedValue ct_jsc_make_latin1_string(
    CtJscInvocation *invocation,
    const uint8_t *data,
    size_t length)
{
    if (!invocation || !invocation->global_object || (!data && length))
        return ct_encode(JSC::jsUndefined());
    auto span = std::span(
        reinterpret_cast<const Latin1Character *>(data),
        length);
    return ct_encode(JSC::jsString(invocation->global_object->vm(), WTF::String(span)));
}

extern "C" CtJscEncodedValue ct_jsc_make_utf16_string(
    CtJscInvocation *invocation,
    const uint16_t *data,
    size_t length)
{
    if (!invocation || !invocation->global_object || (!data && length))
        return ct_encode(JSC::jsUndefined());
    auto span = std::span(reinterpret_cast<const char16_t *>(data), length);
    return ct_encode(JSC::jsString(invocation->global_object->vm(), WTF::String(span)));
}

extern "C" CtJscEncodedValue ct_jsc_make_utf8_string(
    CtJscInvocation *invocation,
    const uint8_t *data,
    size_t length)
{
    if (!invocation || !invocation->global_object || (!data && length))
        return ct_encode(JSC::jsUndefined());
    auto text = WTF::String::fromUTF8ReplacingInvalidSequences(
        std::span(reinterpret_cast<const char8_t *>(data), length));
    return ct_encode(JSC::jsString(invocation->global_object->vm(), std::move(text)));
}

extern "C" CtJscEncodedValue ct_jsc_make_uint8_array_copy(
    CtJscInvocation *invocation,
    const uint8_t *data,
    size_t length)
{
    if (!invocation || !invocation->global_object || (!data && length))
        return ct_encode(JSC::jsUndefined());
    auto *global = invocation->global_object;
    auto *result = JSC::JSUint8Array::createUninitialized(
        global,
        global->typedArrayStructure(JSC::TypeUint8, false),
        length);
    if (!result)
        return ct_encode(JSC::jsUndefined());
    if (length)
        std::memcpy(result->typedVector(), data, length);
    return ct_encode(result);
}

extern "C" CtJscEncodedValue ct_jsc_make_uint8_array_uninitialized(
    CtJscInvocation *invocation,
    size_t length,
    CtJscMutableBytesView *result_view)
{
    if (!invocation || !invocation->global_object || !result_view)
        return ct_encode(JSC::jsUndefined());
    auto *global = invocation->global_object;
    auto *result = JSC::JSUint8Array::createUninitialized(
        global,
        global->typedArrayStructure(JSC::TypeUint8, false),
        length);
    if (!result) {
        result_view->data = nullptr;
        result_view->length = 0;
        return ct_encode(JSC::jsUndefined());
    }
    result_view->data = result->typedVector();
    result_view->length = result->length();
    return ct_encode(result);
}

extern "C" CtJscEncodedValue ct_jsc_throw_type_error(
    CtJscInvocation *invocation,
    const char *message)
{
    if (!invocation || !invocation->global_object)
        return ct_encode(JSC::jsUndefined());
    auto &vm = invocation->global_object->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    JSC::throwTypeError(invocation->global_object, scope, ct_message(message));
    return ct_encode(JSC::jsUndefined());
}

extern "C" CtJscEncodedValue ct_jsc_throw_error(
    CtJscInvocation *invocation,
    const char *message)
{
    if (!invocation || !invocation->global_object)
        return ct_encode(JSC::jsUndefined());
    auto &vm = invocation->global_object->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    JSC::throwException(
        invocation->global_object,
        scope,
        JSC::createError(invocation->global_object, ct_message(message)));
    return ct_encode(JSC::jsUndefined());
}

extern "C" CtJscEncodedValue ct_jsc_throw_value_ref(
    CtJscInvocation *invocation,
    JSValueRef exception)
{
    if (!invocation || !invocation->global_object || !exception)
        return ct_encode(JSC::jsUndefined());
    auto &vm = invocation->global_object->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    JSC::throwException(
        invocation->global_object,
        scope,
        toJS(invocation->global_object, exception));
    return ct_encode(JSC::jsUndefined());
}

extern "C" bool ct_jsc_invocation_has_exception(const CtJscInvocation *invocation)
{
    return invocation && invocation->global_object
        && invocation->global_object->vm().exceptionForInspection();
}
