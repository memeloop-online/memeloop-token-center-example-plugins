(module
  (type $log (func (param i32 i32 i32 i32)))
  (type $kv-get (func (param i32 i32 i32)))
  (type $kv-put (func (param i32 i32 i32 i32 i32)))
  (type $http-request (func (param i32 i32 i32 i32 i32 i32 i32 i32 i32)))
  (type $context-call (func
    (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32)
    (result i32)))
  (type $prepare-call (func
    (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32)
    (result i32)))
  (type $post-one (func (param i32)))
  (type $string-call (func (param i32 i32) (result i32)))
  (type $realloc (func (param i32 i32 i32 i32) (result i32)))
  (type $initialize (func))

  (import "cm32p2|memeloop:token-center/host@0.2" "log" (func $log (type $log)))
  (import "cm32p2|memeloop:token-center/host@0.2" "kv-get" (func $kv-get (type $kv-get)))
  (import "cm32p2|memeloop:token-center/host@0.2" "kv-put" (func $kv-put (type $kv-put)))
  (import "cm32p2|memeloop:token-center/host@0.2" "http-request" (func $http-request (type $http-request)))

  (memory $memory 1)
  (global $heap (mut i32) (i32.const 8192))
  (data (i32.const 64) "{\22model\22:\22example-rewritten\22,\22messages\22:[{\22role\22:\22user\22,\22content\22:\22rewritten by plugin\22}]}")
  (data (i32.const 160) "{\22enabled\22:true}")
  (data (i32.const 192) "[\22example-rewritten\22]")
  (data (i32.const 224) "USD")
  (data (i32.const 232) "0.001")
  (data (i32.const 400) "example-rewritten")
  (data (i32.const 512) "{\22method\22:\22POST\22,\22path\22:\22/vendor/infer\22,\22headers\22:{\22content-type\22:\22application/json\22,\22x-plugin-shape\22:\22buffered-v1\22},\22body_base64\22:\22eyJwcm9tcHQiOiJmcm9tLWNvbXBvbmVudCIsIm1vZGVsIjoidmVuZG9yLW1vZGVsIn0=\22,\22streaming\22:false}")
  (data (i32.const 1024) "{\22status\22:200,\22headers\22:{\22content-type\22:\22application/json\22},\22body_base64\22:\22eyJpZCI6ImNtcC0xIiwib2JqZWN0IjoiY2hhdC5jb21wbGV0aW9uIiwiY2hvaWNlcyI6W3sibWVzc2FnZSI6eyJyb2xlIjoiYXNzaXN0YW50IiwiY29udGVudCI6Im5vcm1hbGl6ZWQgYnkgY29tcG9uZW50In19XSwidXNhZ2UiOnsicHJvbXB0X3Rva2VucyI6NywiY29tcGxldGlvbl90b2tlbnMiOjN9fQ==\22,\22usage\22:{\22input_tokens\22:7,\22output_tokens\22:3,\22estimated\22:false}}")
  (data (i32.const 1536) "{\22status\22:200,")
  (data (i32.const 1568) "fixture expected HTTP 200")

  ;; Compare only the bounded bytes supplied by the canonical ABI. This guest
  ;; deliberately accepts one canonical opt-in spelling instead of parsing JSON.
  (func $bytes-equal (param $left i32) (param $right i32) (param $length i32)
    (result i32)
    (local $index i32)
    block $different
      loop $compare
        local.get $index local.get $length i32.ge_u
        if
          i32.const 1
          return
        end
        local.get $left local.get $index i32.add i32.load8_u
        local.get $right local.get $index i32.add i32.load8_u
        i32.ne
        br_if $different
        local.get $index i32.const 1 i32.add local.set $index
        br $compare
      end
    end
    i32.const 0)

  (func $post-auth (type $context-call)
    ;; request-context is six strings: config-json occupies flat slots 10/11;
    ;; the following request-json occupies slots 12/13 (zero-based).
    (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32)
    (param $config-ptr i32) (param $config-len i32) (param i32 i32)
    (result i32)
    ;; BEGIN POST-AUTH BODY
    ;; Default result<decision,string>: Ok, allow, no model/account/body changes.
    ;; Reset all option tags even if this instance is called more than once.
    i32.const 256 i32.const 0 i32.store
    i32.const 260 i32.const 1 i32.store
    i32.const 264 i32.const 0 i32.store
    i32.const 276 i32.const 0 i32.store
    i32.const 288 i32.const 0 i32.store
    i32.const 300 i32.const 0 i32.store
    ;; The host validates the one-field schema then serde_json::to_string emits
    ;; exactly {"enabled":true}. Every other byte sequence stays disabled.
    local.get $config-len i32.const 16 i32.eq
    if
      local.get $config-ptr i32.const 160 i32.const 16 call $bytes-equal
      if
        i32.const 276 i32.const 1 i32.store
        i32.const 280 i32.const 400 i32.store
        i32.const 284 i32.const 17 i32.store
        i32.const 300 i32.const 1 i32.store
        i32.const 304 i32.const 64 i32.store
        i32.const 308 i32.const 90 i32.store
      end
    end
    i32.const 256
    ;; END POST-AUTH BODY
  )

  (func $post-auth-post (type $post-one) (param i32))

  (func $list-models (type $string-call) (param i32 i32) (result i32)
    i32.const 320 i32.const 0 i32.store
    i32.const 324 i32.const 192 i32.store
    i32.const 328 i32.const 21 i32.store
    i32.const 320)

  (func $list-models-post (type $post-one) (param i32))

  (func $quote (type $context-call)
    (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32)
    (result i32)
    i32.const 336 i32.const 0 i32.store
    i32.const 344 i32.const 224 i32.store
    i32.const 348 i32.const 3 i32.store
    i32.const 352 i32.const 232 i32.store
    i32.const 356 i32.const 5 i32.store
    i32.const 360 i64.const 1 i64.store
    i32.const 368 i64.const 1 i64.store
    i32.const 376 i32.const 1 i32.store
    i32.const 336)

  (func $quote-post (type $post-one) (param i32))

  (func $prepare (type $prepare-call)
    (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32)
    (result i32)
    ;; BEGIN PREPARE BODY
    i32.const 768 i32.const 0 i32.store
    i32.const 772 i32.const 512 i32.store
    i32.const 776 i32.const 220 i32.store
    i32.const 768
    ;; END PREPARE BODY
  )

  (func $prepare-post (type $post-one) (param i32))

  (func $normalize (type $context-call)
    (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32)
    (param $response-ptr i32) (param $response-len i32)
    (result i32)
    ;; BEGIN NORMALIZE BODY
    ;; The host serializes UpstreamResponseEnvelope with status first, without
    ;; whitespace. Only an exact HTTP 200 envelope can produce fixture output;
    ;; redirects, errors and unrecognized envelopes must never become success.
    i32.const 784 i32.const 1 i32.store
    i32.const 788 i32.const 1568 i32.store
    i32.const 792 i32.const 25 i32.store
    local.get $response-len i32.const 14 i32.lt_u
    if
      i32.const 784
      return
    end
    local.get $response-ptr i32.const 1536 i32.const 14 call $bytes-equal
    i32.eqz
    if
      i32.const 784
      return
    end
    i32.const 784 i32.const 0 i32.store
    i32.const 788 i32.const 1024 i32.store
    i32.const 792 i32.const 372 i32.store
    i32.const 784
    ;; END NORMALIZE BODY
  )

  (func $normalize-post (type $post-one) (param i32))

  (func $realloc (type $realloc) (param i32 i32 i32 i32) (result i32)
    (local $result i32)
    global.get $heap
    local.tee $result
    local.get 3
    i32.add
    global.set $heap
    local.get $result)

  (func $initialize (type $initialize))

  (export "cm32p2|memeloop:token-center/traffic-policy@0.2|post-auth" (func $post-auth))
  (export "cm32p2|memeloop:token-center/traffic-policy@0.2|post-auth_post" (func $post-auth-post))
  (export "cm32p2|memeloop:token-center/upstream-provider@0.2|list-models" (func $list-models))
  (export "cm32p2|memeloop:token-center/upstream-provider@0.2|list-models_post" (func $list-models-post))
  (export "cm32p2|memeloop:token-center/upstream-provider@0.2|quote" (func $quote))
  (export "cm32p2|memeloop:token-center/upstream-provider@0.2|quote_post" (func $quote-post))
  (export "cm32p2|memeloop:token-center/upstream-provider@0.2|prepare" (func $prepare))
  (export "cm32p2|memeloop:token-center/upstream-provider@0.2|prepare_post" (func $prepare-post))
  (export "cm32p2|memeloop:token-center/upstream-provider@0.2|normalize" (func $normalize))
  (export "cm32p2|memeloop:token-center/upstream-provider@0.2|normalize_post" (func $normalize-post))
  (export "cm32p2_memory" (memory $memory))
  (export "cm32p2_realloc" (func $realloc))
  (export "cm32p2_initialize" (func $initialize))
)
