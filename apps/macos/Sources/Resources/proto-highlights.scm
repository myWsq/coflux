; 来源：treywood/tree-sitter-proto e9f6b43f6844bd2189b50a422d4e2094313f6aa3，MIT许可随App分发。
[
  "syntax"
  "package"
  "option"
  "import"
  "service"
  "rpc"
  "returns"
  "message"
  "enum"
  "oneof"
  "repeated"
  "reserved"
  "to"
] @keyword

[
  (key_type)
  (type)
  (message_name)
  (enum_name)
  (service_name)
  (rpc_name)
]@type

(string) @string

[
  (int_lit)
  (float_lit)
] @number

[
  (true)
  (false)
] @constant.builtin

(comment) @comment

[
  "("
  ")"
  "["
  "]"
  "{"
  "}"
]  @punctuation.bracket

; 本地主题适配：内置标量类型与赋值符使用 Web 的关键词/运算符颜色。
["double" "float" "int32" "int64" "uint32" "uint64" "sint32" "sint64"
 "fixed32" "fixed64" "sfixed32" "sfixed64" "bool" "string" "bytes"] @keyword
"=" @operator
; syntax 版本是专用字面量，而非通用 string 节点。
["\"proto2\"" "\"proto3\""] @string
