; 来源：tree-sitter-grammars/tree-sitter-vue 22bdfa6c9fc0f5ffa44c6e938ec46869ac8a99ff，MIT。
; inherits: html_tags
[
  (dynamic_directive_inner_value)
] @tag

[
  "["
  "]"
] @punctuation.bracket

(interpolation) @punctuation.special

(interpolation
  (raw_text) @none)

; 本地映射：Web 将指令名、参数和修饰符按属性着色。
(directive_name) @attribute

(directive_attribute
  (quoted_attribute_value) @punctuation.special)

(directive_attribute
  (quoted_attribute_value
    (attribute_value) @none))

[
  (directive_modifier)
  (directive_value)
] @attribute

