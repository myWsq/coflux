; 上游 c8e7cbbd1589cc2ee1f9b5befa604dc7e953b0af；Dart 类型按 Web 主题使用蓝色。
; Variable
(identifier) @variable

; Keywords
; --------------------
[
    (assert_builtin)
    (break_builtin)
    (const_builtin)
    (part_of_builtin)
    (rethrow_builtin)
    (void_type)
    "abstract"
    "as"
    "async"
    "async*"
    "await"
    "base"
    "case"
    "catch"
    "class"
    "continue"
    "covariant"
    "default"
    "deferred"
    "do"
    "else"
    "enum"
    "export"
    "extends"
    "extension"
    "external"
    "factory"
    "final"
    "finally"
    "for"
    "Function"
    "get"
    "hide"
    "if"
    "implements"
    "import"
    "in"
    "interface"
    "is"
    "late"
    "library"
    "mixin"
    "new"
    "on"
    "operator"
    "part"
    "required"
    "return"
    "sealed"
    "set"
    "show"
    "static"
    "super"
    "switch"
    "sync*"
    "throw"
    "try"
    "typedef"
    "var"
    "when"
    "while"
    "with"
    "yield"
] @keyword

; Methods
; --------------------

; NOTE: This query is a bit of a work around for the fact that the dart grammar doesn't
; specifically identify a node as a function call
(((identifier) @function (#match? @function "^_?[a-z]"))
 . (selector . (argument_part))) @function

; Annotations
; --------------------
(annotation
  name: (identifier) @attribute)

; Operators and Tokens
; --------------------
(template_substitution
  "$" @punctuation.special
  "{" @punctuation.special
  "}" @punctuation.special
) @none

(template_substitution
  "$" @punctuation.special
  (identifier_dollar_escaped) @variable
) @none

(escape_sequence) @string.escape

[
 "@"
 "=>"
 ".."
 "??"
 "=="
 "?"
 ":"
 "&&"
 "%"
 "<"
 ">"
 "="
 ">="
 "<="
 "||"
 "~/"
 (increment_operator)
 (is_operator)
 (prefix_operator)
 (equality_operator)
 (additive_operator)
] @operator

(type_arguments
  "<" @punctuation.bracket
  ">" @punctuation.bracket)

(type_parameters
  "<" @punctuation.bracket
  ">" @punctuation.bracket)

[
  "("
  ")"
  "["
  "]"
  "{"
  "}"
]  @punctuation.bracket

; Delimiters
; --------------------
[
  ";"
  "."
  ","
] @punctuation.delimiter

; Types
; --------------------
(type_identifier) @type.dart
((type_identifier) @type.dart.builtin
  (#match? @type.dart.builtin "^(int|double|String|bool|List|Set|Map|Runes|Symbol)$"))
(class_definition
  name: (identifier) @type.dart)
(constructor_signature
  name: (identifier) @type.dart)
(scoped_identifier
  scope: (identifier) @type.dart)
(function_signature
  name: (identifier) @function)
(getter_signature
  (identifier) @function)
(setter_signature
  name: (identifier) @function)

((scoped_identifier
  scope: (identifier) @type.dart
  name: (identifier) @type.dart)
 (#match? @type.dart "^[a-zA-Z]"))

; Enums
; -------------------
(enum_declaration
  name: (identifier) @type.dart)
(enum_constant
  name: (identifier) @identifier.constant)

; Variables
; --------------------
; var keyword
(inferred_type) @keyword

((identifier) @type.dart
 (#match? @type.dart "^_?[A-Z].*[a-z]"))

("Function" @type.dart)

(this) @variable.builtin

; properties

(unconditional_assignable_selector
  (identifier) @property)

(conditional_assignable_selector
  (identifier) @property)

(cascade_section
  (cascade_selector
    (identifier) @property))

((selector
  (unconditional_assignable_selector (identifier) @function))
  (selector (argument_part (arguments)))
)

(cascade_section
  (cascade_selector (identifier) @function)
  (argument_part (arguments))
)

; assignments
(assignment_expression
  left: (assignable_expression) @variable)

(this) @variable.builtin

; Parameters
; --------------------
(formal_parameter
    name: (identifier) @identifier.parameter)

(named_argument
  (label (identifier) @identifier.parameter))

; Literals
; --------------------
[
    (hex_integer_literal)
    (decimal_integer_literal)
    (decimal_floating_point_literal)
    ; TODO: inaccessbile nodes
    ; (octal_integer_literal)
    ; (hex_floating_point_literal)
] @number

(string_literal) @string
(symbol_literal (identifier) @constant) @constant
(true) @boolean
(false) @boolean
(null_literal) @constant.null

(documentation_comment) @comment
(comment) @comment

; 补齐当前 Web 主题的扩展类型与简单字符串插值；raw 字符串无此语法节点。
(extension_type_declaration "type" @keyword name: (identifier) @type.dart)
(template_substitution "$" @punctuation.dart)
(template_substitution "{" @punctuation.dart "}" @punctuation.dart)
(template_substitution (identifier) @variable.dart)
(template_substitution (identifier_dollar_escaped) @variable.dart)
