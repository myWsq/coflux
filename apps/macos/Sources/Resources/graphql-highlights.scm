; 来源：bkegley/tree-sitter-graphql 5e66e961eee421786bdda8495ed1db045e06b5fe，MIT许可随App分发。
; Types
;------

(scalar_type_definition
  (name) @type.graphql)

(object_type_definition
  (name) @type.graphql)

(interface_type_definition
  (name) @type.graphql)

(union_type_definition
  (name) @type.graphql)

(enum_type_definition
  (name) @type.graphql)

(input_object_type_definition
  (name) @type.graphql)

(directive_definition
  (name) @type.graphql)

(directive_definition
  "@" @type.graphql)

(scalar_type_extension
  (name) @type.graphql)

(object_type_extension
  (name) @type.graphql)

(interface_type_extension
  (name) @type.graphql)

(union_type_extension
  (name) @type.graphql)

(enum_type_extension
  (name) @type.graphql)

(input_object_type_extension
  (name) @type.graphql)

(named_type
  (name) @type.graphql)

(directive) @type.graphql

; Properties
;-----------

(field
  (name) @property.graphql)

(field
  (alias
    (name) @property.graphql))

(field_definition
  (name) @property.graphql)

(object_value
  (object_field
    (name) @property.graphql))

(enum_value
  (name) @property.graphql)

; Variable Definitions and Arguments 
;-----------------------------------

(operation_definition
  (name) @function.graphql)

(fragment_name
  (name) @variable.graphql)

(input_fields_definition
  (input_value_definition
    (name) @parameter.graphql))

(argument
  (name) @parameter.graphql)

(arguments_definition
  (input_value_definition
    (name) @parameter.graphql))

(variable_definition
  (variable) @parameter.graphql)

(argument
  (value
    (variable) @variable.graphql))

; Constants
;----------

(string_value) @string

(int_value) @number

(float_value) @number.float

(boolean_value) @boolean

; Literals
;---------

(description) @comment

(comment) @comment

(directive_location
  (executable_directive_location) @type.graphql.builtin)

(directive_location
  (type_system_directive_location) @type.graphql.builtin)

; Keywords
;----------

[
  "query"
  "mutation"
  "subscription"
  "fragment"
  "scalar"
  "type"
  "interface"
  "union"
  "enum"
  "input"
  "extend"
  "directive"
  "schema"
  "on"
  "repeatable"
  "implements"
] @keyword

; Punctuation
;------------

[
 "("
 ")"
 "["
 "]"
 "{"
 "}"
] @punctuation.bracket

"=" @operator

"|" @punctuation.delimiter
"&" @punctuation.delimiter
":" @punctuation.delimiter

"..." @punctuation.special
"!" @punctuation.special

; 本地主题适配：可空性标记属于运算符，浮点数沿用数字分类。
"!" @operator.graphql
