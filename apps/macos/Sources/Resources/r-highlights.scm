; 来源：r-lib/tree-sitter-r v1.3.0，许可随App分发。
; highlights.scm

; Literals

(integer) @number
(float) @number
(complex) @number

(string) @string
(string (string_content (escape_sequence) @string.escape))

; Comments

(comment) @comment

; Operators

[
  "?" ":=" "=" "<-" "<<-" "->" "->>"
  "~" "|>" "||" "|" "&&" "&"
  "<" "<=" ">" ">=" "==" "!="
  "+" "-" "*" "/" "::" ":::"
  "**" "^" "$" "@" ":" "!"
  "special"
] @operator

; Punctuation

[
  "("  ")"
  "{"  "}"
  "["  "]"
  "[[" "]]"
] @punctuation.bracket

(comma) @punctuation.delimiter

; Variables

(identifier) @variable.r

; Functions

(binary_operator
    lhs: (identifier) @variable.r
    operator: "<-"
    rhs: (function_definition)
)

(binary_operator
    lhs: (identifier) @variable.r
    operator: "="
    rhs: (function_definition)
)

; Calls

(call function: (identifier) @function.r)

; - `return` is just a regular identifier in our grammar (#189), but people
;   expect `return()` to be highlighted
; - We feel confident that we can use `#eq?` here, as other grammars use
;   `#eq?` and `#match?` predicates already, even though support for predicates
;   is dependent on the library that binds to tree-sitter's C library, not the
;   C library itself.
;   https://github.com/tree-sitter/tree-sitter-javascript/blob/58404d8cf191d69f2674a8fd507bd5776f46cb11/queries/highlights.scm#L65-L67
;   https://github.com/tree-sitter/tree-sitter-rust/blob/77a3747266f4d621d0757825e6b11edcbf991ca5/queries/highlights.scm#L9-L11
; - Placed after `(call function: (identifier) @function.r)` for correct precedence
(
    (call function: (identifier) @keyword.r)
    (#eq? @keyword.r "return")
)

; Parameters

(parameters (parameter name: (identifier) @variable.r.parameter))
(arguments (argument name: (identifier) @variable.r.parameter))

; Namespace

(namespace_operator lhs: (identifier) @namespace)

(call
    function: (namespace_operator rhs: (identifier) @function.r)
)

; Keywords

(function_definition name: "function" @keyword.r.function)
(function_definition name: "\\" @operator)

[
  "in"
  (next)
  (break)
] @keyword.r

[
  "if"
  "else"
] @conditional

[
  "while"
  "repeat"
  "for"
] @repeat

[
  (true)
  (false)
] @boolean

[
  (null)
  (inf)
  (nan)
  (na)
  (dots)
  (dot_dot_i)
] @constant.builtin

; Error

(ERROR) @error
