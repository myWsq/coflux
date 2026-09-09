import XCTest
@testable import Coflux

final class NativeDiffHighlighterTests: XCTestCase {
    func testMarkdownCodeDefaultForegroundDoesNotInheritFenceColor() async throws {
        let source = "```typescript\nlet ordinary = 42; // 注释😀\n```\n"
        let spans = try await NativeDiffHighlighter.shared.highlight(source, path: "README.md")
        let text = source as NSString
        for (token, color): (String, UInt32) in [("ordinary", 0xe6edf3), ("let", 0xff7b72), ("42", 0x79c0ff), ("注释😀", 0x8b949e)] {
            let offset = text.range(of: token).location
            XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, token)
        }
    }

    func testGroovyClassesClosuresInterpolationAndMarkdown() async throws {
        let code = #"""
        // 注释😀
        class Greeter { def greet(name) { return "你好😀 ${name}" } }
        def values = [1, 42].collect { it * 2 };
        println values
        """#
        for (path, source) in [("main.groovy", code), ("main.GROOVY", code), ("README.md", "```groovy\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("class", 0xff7b72), ("Greeter", 0xffa657), ("def", 0xff7b72), ("greet", 0xd2a8ff), ("return", 0xff7b72), ("你好😀", 0xa5d6ff), ("42", 0x79c0ff), ("collect", 0xd2a8ff), ("println", 0x79c0ff)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testZshNativeArraysGlobQualifiersAndParameterExpansion() async throws {
        let code = #"""
        # 注释😀
        function greet() { local name="你好😀"; print -r -- "$name" }
        files=(**/*.swift(N.))
        print -l -- ${(u)files}
        for file in $files; do print "$file"; done
        """#
        for (path, source) in [("main.zsh", code), ("main.ZSH", code), ("README.md", "```zsh\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("function", 0xff7b72), ("greet", 0xd2a8ff), ("local", 0xff7b72), ("你好😀", 0xa5d6ff), ("print", 0x79c0ff), ("N.", 0xffa657), ("for", 0xff7b72), ("done", 0xff7b72)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            for token in ["$name", "${(u)files}"] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, 0xe6edf3, path + ":" + token)
            }
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testPowerShellFunctionsCommandsVariablesAndUnicode() async throws {
        let code = #"""
        # 注释😀
        function Greet { param([string]$Name)
          $Value = 42; if ($Value -gt 12) { Write-Host "你好😀 $Name" }
        }
        """#
        for (path, source) in [("main.ps1", code), ("main.PS1", code), ("README.md", "```powershell\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("function", 0xff7b72), ("Greet", 0xd2a8ff), ("param", 0xff7b72), ("string", 0xff7b72), ("42", 0x79c0ff), ("-gt", 0xff7b72), ("Write-Host", 0x79c0ff), ("你好😀", 0xa5d6ff)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            let variable = text.range(of: "$Name", options: .backwards).location
            XCTAssertEqual(spans.last(where: { NSLocationInRange(variable, $0.range) })?.color, 0xe6edf3)
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testPerlFunctionsInterpolationRegexAndMarkdown() async throws {
        let code = #"""
        # 注释😀
        use strict;
        sub greet { my $name = "你好😀"; return $name; }
        my $value = 42; print "hello $value";
        $value =~ /hello+/i;
        """#
        for (path, source) in [("main.pl", code), ("main.PL", code), ("README.md", "```perl\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("use", 0xff7b72), ("sub", 0xff7b72), ("greet", 0xd2a8ff), ("my", 0xff7b72), ("你好😀", 0xa5d6ff), ("return", 0xff7b72), ("42", 0x79c0ff), ("print", 0x79c0ff), ("hello+", 0xa5d6ff), ("i;", 0xff7b72)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            let interpolation = text.range(of: "$value\"").location
            XCTAssertEqual(spans.last(where: { NSLocationInRange(interpolation, $0.range) })?.color, 0xe6edf3)
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testVueNativeTemplateTypeScriptLessAndMarkdown() async throws {
        let code = """
        <script setup lang="ts">
        // 注释😀
        const size: number = 42;
        const text = "你好😀";
        </script>
        <template><button :disabled="size > 12" @click="greet('点击😀')">{{ size + 7 }}</button></template>
        <style scoped lang="less">@width: 24px; .card { width: @width; }</style>
        """
        for (path, source) in [("App.vue", code), ("App.VUE", code), ("README.md", "```vue\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("const", 0xff7b72), ("42", 0x79c0ff), ("你好😀", 0xa5d6ff), ("button", 0x7ee787), ("disabled", 0x79c0ff), ("click", 0x79c0ff), ("12", 0x79c0ff), ("greet", 0xd2a8ff), ("点击😀", 0xa5d6ff), ("7", 0x79c0ff), ("24", 0x79c0ff), ("px", 0xff7b72)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testSvelteNativeExpressionsBlocksTypeScriptAndSCSS() async throws {
        let code = """
        <script lang="ts">const count: number = 42; // 注释😀
        </script>
        {#if count > 12}<button onclick={() => greet("你好😀")}>{count + 7}</button>{:else}<p>empty</p>{/if}
        <style lang="scss">$size: 24px; .card { width: $size; }</style>
        """
        for (path, source) in [("App.svelte", code), ("App.SVELTE", code), ("README.md", "```svelte\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("const", 0xff7b72), ("42", 0x79c0ff), ("注释😀", 0x8b949e), ("if", 0xff7b72), ("12", 0x79c0ff), ("button", 0x7ee787), ("greet", 0xd2a8ff), ("你好😀", 0xa5d6ff), ("7", 0x79c0ff), ("else", 0xff7b72), ("24", 0x79c0ff), ("px", 0xff7b72)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testComponentBoundariesDoNotParseLiteralAttributesCommentsOrUnsupportedLanguages() async throws {
        for ext in ["vue", "svelte"] {
            let source = """
            <!-- const comment = 42; -->
            <div title="const literal = 17">plain</div>
            <script lang="unknown">const untouched = 91;</script>
            <style lang="unknown">.card { width: 83px; }</style>
            <script type="application/json">{"value": 62}</script>
            """
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: "App." + ext)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("comment", 0x8b949e), ("literal", 0xa5d6ff), ("62", 0x79c0ff)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, ext + ":" + token)
            }
            for token in ["91", "83"] {
                let offset = text.range(of: token).location
                XCTAssertFalse(spans.contains { NSLocationInRange(offset, $0.range) && $0.color == 0x79c0ff }, ext + ":" + token)
            }
        }
    }

    func testLessVariablesMixinsNestingAndMarkdown() async throws {
        let code = "// 注释😀\n@size: 12px;\n.rounded(@radius: 4px) { border-radius: @radius; }\n.card { .rounded(6px); content: \"你好😀\"; &:hover { width: @size; } }"
        for (path, source) in [("theme.less", code), ("theme.LESS", code), ("README.md", "```less\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("size", 0x79c0ff), ("12", 0x79c0ff), ("px", 0xff7b72), ("rounded", 0x79c0ff), ("radius", 0x79c0ff), ("border-radius", 0x79c0ff), ("card", 0x79c0ff), ("你好😀", 0xa5d6ff), ("hover", 0x79c0ff), ("width", 0x79c0ff)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            let reference = text.range(of: "size", options: .backwards).location
            XCTAssertEqual(spans.last(where: { NSLocationInRange(reference, $0.range) })?.color, 0x79c0ff)
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testDartClassesCallsUnicodeAndMarkdown() async throws {
        let code = "// 注释😀\nclass Greeter {\n  String greet(int value) {\n    final text = \"你好😀\";\n    if (value > 42) return text;\n    return \"hello\";\n  }\n}\nvoid main() { print(Greeter().greet(42)); }"
        for (path, source) in [("main.dart", code), ("main.DART", code), ("README.md", "```dart\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("class", 0xff7b72), ("Greeter", 0x79c0ff), ("String", 0x79c0ff), ("greet", 0xd2a8ff), ("final", 0xff7b72), ("你好😀", 0xa5d6ff), ("42", 0x79c0ff), ("return", 0xff7b72), ("main", 0xd2a8ff), ("print", 0xd2a8ff)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
            let argument = text.range(of: "42", options: .backwards).location
            XCTAssertEqual(spans.last(where: { NSLocationInRange(argument, $0.range) })?.color, 0x79c0ff, "调用不能覆盖实参数字颜色")
        }
    }

    func testDartRawStringsInterpolationAndExtensionType() async throws {
        let source = #"""
        extension type UserId(int value) {}
        final raw = r"$rawName 你好😀";
        final message = "hello ${name} $simple";
        final number = 1.5;
        """#
        let spans = try await NativeDiffHighlighter.shared.highlight(source, path: "types.dart")
        let text = source as NSString
        for (token, color): (String, UInt32) in [("extension", 0xff7b72), ("type", 0xff7b72), ("UserId", 0x79c0ff), ("int", 0x79c0ff), ("rawName", 0xa5d6ff), ("你好😀", 0xa5d6ff), ("name}", 0x79c0ff), ("simple", 0x79c0ff), ("1.5", 0x79c0ff), ("${", 0xe6edf3)] {
            let offset = text.range(of: token).location
            XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, token)
        }
        XCTAssertTrue(spans.allSatisfy { NSMaxRange($0.range) <= text.length })
    }

    func testRFunctionsVariablesAndMarkdown() async throws {
        let code = "# 注释😀\ngreet <- function(x) { if (x > 42) return(\"你好😀\") }\nresult <- mean(c(1, 2))"
        for (path, source) in [("analysis.r", code), ("analysis.R", code), ("README.md", "```r\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("greet", 0xffa657), ("function", 0xff7b72), ("42", 0x79c0ff), ("return", 0xff7b72), ("你好😀", 0xa5d6ff), ("mean", 0xd2a8ff)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testINIQuotedValuesAndBareValuesRemainDistinct() async throws {
        let source = "[server]\nquoted = \"hello😀\"\nsingle = '你好'\nport = 8080\nenabled = true\nplain = text\n"
        let spans = try await NativeDiffHighlighter.shared.highlight(source, path: "settings.ini")
        let text = source as NSString
        for token in ["hello😀", "你好"] {
            let offset = text.range(of: token).location
            XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, 0xa5d6ff, token)
        }
        for token in ["8080", "true", "text"] {
            let offset = text.range(of: token).location
            XCTAssertNil(spans.last(where: { NSLocationInRange(offset, $0.range) }), token)
        }
    }

    func testINISectionsKeysQuotedValuesAndMarkdown() async throws {
        let code = "; 注释😀\n[server]\nname=你好😀\nport=8080\nquoted=\"hello😀\"\n"
        for (path, source) in [("config.ini", code), ("config.INI", code), ("README.md", "```ini\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("server", 0xffa657), ("name", 0xff7b72), ("port", 0xff7b72), ("hello😀", 0xa5d6ff)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testSQLQueriesDDLNumbersAndMarkdown() async throws {
        let code = "-- 注释😀\nCREATE TABLE users (id INTEGER, name TEXT);\nSELECT name, 42, 1.5, 2e3, '你好😀' FROM users WHERE id > 0;"
        for (path, source) in [("query.sql", code), ("query.SQL", code), ("README.md", "```sql\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("CREATE", 0xff7b72), ("SELECT", 0xff7b72), ("FROM", 0xff7b72), ("WHERE", 0xff7b72), ("42", 0x79c0ff), ("1.5", 0x79c0ff), ("2e3", 0x79c0ff), ("你好😀", 0xa5d6ff)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testProtoMessagesEnumsAndMarkdown() async throws {
        let code = "syntax = \"proto3\";\n// 注释😀\nmessage User { string name = 1; repeated int32 scores = 2; }\nenum State { UNKNOWN = 0; }"
        for (path, source) in [("user.proto", code), ("user.PROTO", code), ("README.md", "```proto\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("syntax", 0xff7b72), ("proto3", 0xa5d6ff), ("User", 0xffa657), ("string", 0xff7b72), ("repeated", 0xff7b72), ("int32", 0xff7b72), ("State", 0xffa657), ("1;", 0x79c0ff), ("=", 0xff7b72)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testJSON5UnquotedKeysSpecialNumbersAndMarkdown() async throws {
        let code = "// 注释😀\n{unquoted: '你好😀', hex: 0x2A, fraction: .5, infinity: Infinity, nan: NaN, enabled: true, /*块注释*/}"
        for (path, source) in [("config.json5", code), ("config.JSON5", code), ("README.md", "```json5\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("块注释", 0x8b949e), ("unquoted", 0xa5d6ff), ("你好😀", 0xa5d6ff), ("0x2A", 0x79c0ff), (".5", 0x79c0ff), ("Infinity", 0x79c0ff), ("NaN", 0x79c0ff), ("true", 0x79c0ff)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testGraphQLQueriesSchemaAndMarkdown() async throws {
        let code = "# 注释😀\nquery GetUser($id: ID!) { user(id: $id, score: 1.5, active: true) { name(message: \"你好😀\") } }\ntype User { id: ID! }"
        for (path, source) in [("user.graphql", code), ("user.GQL", code), ("README.md", "```graphql\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("query", 0xff7b72), ("GetUser", 0xd2a8ff), ("$id", 0xffa657), ("ID", 0x79c0ff), ("user(", 0xffa657), ("1.5", 0x79c0ff), ("true", 0x79c0ff), ("你好😀", 0xa5d6ff), ("!", 0xff7b72)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testSCSSMixinsNestedRulesAndMarkdown() async throws {
        let code = "// 注释😀\n$spacing: 12px;\n@mixin panel($size) { padding: $size; }\n.card { @include panel($spacing); &:hover { content: \"你好😀\"; color: #abc; } }"
        for (path, source) in [("theme.scss", code), ("theme.SCSS", code), ("README.md", "```scss\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("$spacing", 0xffa657), ("$size", 0xffa657), ("px", 0xff7b72), ("@mixin", 0xff7b72), ("panel", 0xd2a8ff), ("12", 0x79c0ff), ("padding", 0x79c0ff), ("你好😀", 0xa5d6ff)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testErlangDefinitionsStringsAndMarkdown() async throws {
        let code = "% 注释😀\n-module(example).\ngreet(Name) ->\n  case Name of\n    world -> {42, \"你好😀\"};\n    _ -> false\n  end."
        for (path, source) in [("example.erl", code), ("header.HRL", code), ("README.md", "```erlang\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("greet", 0xd2a8ff), ("case", 0xff7b72), ("world", 0x79c0ff), ("42", 0x79c0ff), ("你好😀", 0xa5d6ff)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testHaskellDefinitionsStringsAndMarkdown() async throws {
        let code = "-- 注释😀\nmodule Example where\ngreet name = if name == 42 then \"你好😀\" else \"再见\""
        for (path, source) in [("Example.hs", code), ("Example.HS", code), ("README.md", "```haskell\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("module", 0xff7b72), ("greet", 0xd2a8ff), ("if", 0xff7b72), ("42", 0x79c0ff), ("你好😀", 0xa5d6ff)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testElixirDefinitionsUnicodeAndMarkdown() async throws {
        let code = "# 注释😀\ndefmodule Example do\n  def greet(name) do\n    count = 42\n    {count, \"你好😀\", :ok}\n  end\nend"
        for (path, source) in [("example.ex", code), ("script.EXS", code), ("README.md", "```elixir\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("defmodule", 0xff7b72), ("greet", 0xd2a8ff), ("42", 0x79c0ff), ("你好😀", 0xa5d6ff)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testKotlinInterpolationAndMultilineStrings() async throws {
        let source = "val message = \"你好😀 $name ${count + 1} ${greet()}\"\nval raw = \"\"\"多行\n$other ${size + 2}\"\"\"" +
            "\nval escaped = \"\\$literal $用户\"\n// $comment"
        let spans = try await NativeDiffHighlighter.shared.highlight(source, path: "template.kt")
        let text = source as NSString
        for (token, color): (String, UInt32) in [("你好😀", 0xa5d6ff), ("$name", 0x79c0ff), ("count", 0xa5d6ff), ("+", 0xff7b72), ("1", 0x79c0ff), ("greet", 0xd2a8ff), ("多行", 0xa5d6ff), ("$other", 0x79c0ff), ("2", 0x79c0ff)] {
            let offset = text.range(of: token).location
            XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, token)
        }
        XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        for (token, color): (String, UInt32) in [("$literal", 0xa5d6ff), ("$用户", 0x79c0ff), ("$comment", 0x8b949e)] {
            let offset = text.range(of: token).location
            XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, token)
        }
    }

    func testKotlinKeywordsTypesStringsAndMarkdown() async throws {
        let code = "// 注释😀\nfun greet(name: String): String { val count = 42; return \"你好😀\" }"
        for (path, source) in [("example.kt", code), ("build.KTS", code), ("README.md", "```kotlin\n" + code + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("fun", 0xff7b72), ("greet", 0xd2a8ff), ("String", 0xffa657), ("42", 0x79c0ff), ("你好😀", 0xa5d6ff)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
    }

    func testConstDeclarationColorPreservesFunctionAndMutableNames() async throws {
        let source = "// 中文😀\nconst greeting = \"hello\"; const value = 42; const run = () => 1; let mutable = 2;"
        for path in ["example.js", "example.jsx", "example.ts", "example.tsx"] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            for (token, color): (String, UInt32) in [("greeting", 0x79c0ff), ("value", 0x79c0ff), ("run", 0xd2a8ff), ("hello", 0xa5d6ff)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, path + ":" + token)
            }
            let mutable = text.range(of: "mutable").location
            XCTAssertNil(spans.last(where: { NSLocationInRange(mutable, $0.range) }))
        }
    }

    func testPHPHolesPreserveHTMLAttributeCommentAndScriptContexts() async throws {
        let source = "<div title=\"前😀<?php echo 42; ?>属性后\">内容</div>\n<!-- 注释前<?php echo 7; ?>注释后 -->\n<script>const message = \"脚本前<?= 8 ?>脚本后\"; const tail = 9;</script>"
        let text = source as NSString
        let spans = try await NativeDiffHighlighter.shared.highlight(source, path: "contexts.php")
        for (token, color): (String, UInt32) in [("属性后", 0xa5d6ff), ("注释后", 0x8b949e), ("脚本后", 0xa5d6ff), ("const", 0xff7b72), ("echo", 0xff7b72), ("42", 0x79c0ff), ("7;", 0x79c0ff), ("8 ?>", 0x79c0ff), ("9;", 0x79c0ff)] {
            let offset = text.range(of: token).location
            XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, token)
        }
        XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
    }

    func testPHPTemplateHTMLAndTaglessMarkdownStaySeparated() async throws {
        let source = "<section title=\"标题😀\">外层<?php echo \"<fake>字符串😀</fake>\"; ?><b>结束</b></section>"
        let text = source as NSString
        let spans = try await NativeDiffHighlighter.shared.highlight(source, path: "template.php")
        for (token, color): (String, UInt32) in [("section", 0x7ee787), ("title", 0x79c0ff), ("标题😀", 0xa5d6ff), ("echo", 0xff7b72), ("fake", 0xa5d6ff), ("b>", 0x7ee787)] {
            let offset = text.range(of: token).location
            XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, token)
        }
        let markdown = "前缀😀\n```php\n// 注释😀\nfunction greet() { return 42; }\n```\n"
        let embedded = try await NativeDiffHighlighter.shared.highlight(markdown, path: "README.md")
        for (token, color): (String, UInt32) in [("function", 0xff7b72), ("return", 0xff7b72), ("42", 0x79c0ff), ("注释😀", 0x8b949e)] {
            let offset = (markdown as NSString).range(of: token).location
            XCTAssertEqual(embedded.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, token)
        }
        XCTAssertTrue(spans.allSatisfy { NSMaxRange($0.range) <= text.length })
        XCTAssertTrue(embedded.allSatisfy { NSMaxRange($0.range) <= (markdown as NSString).length })
    }

    func testPHPKeywordsStringsNumbersCommentsAndMarkdownFence() async throws {
        let source = "<?php\n// 注释😀\nfunction greet(): string { $count = 42; return \"你好😀\"; }\n?>"
        for (path, contents) in [("example.PHP", source), ("README.md", "前缀😀\n```php\n" + source + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(contents, path: path)
            let text = contents as NSString
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
            for (token, color): (String, UInt32) in [("function", 0xff7b72), ("return", 0xff7b72), ("greet", 0xd2a8ff), ("42", 0x79c0ff), ("你好😀", 0xa5d6ff), ("注释😀", 0x8b949e)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, "\(path): \(token)")
            }
        }
    }

    func testXMLTagsAttributesEntitiesAndMarkdownFences() async throws {
        let source = "<?xml version=\"1.0\"?>\n<!-- 注释😀 -->\n<root name=\"你好😀\"><child>&amp;</child><![CDATA[<literal>]]></root>"
        for (path, contents) in [("sample.XML", source), ("README.md", "前缀😀\n```xml\n" + source + "\n```\n")] {
            let spans = try await NativeDiffHighlighter.shared.highlight(contents, path: path)
            let text = contents as NSString
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
            for (token, color): (String, UInt32) in [("root", 0x7ee787), ("child", 0x7ee787), ("name", 0x79c0ff), ("你好😀", 0xa5d6ff), ("&amp;", 0x79c0ff), ("注释😀", 0x8b949e)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, "\(path): \(token)")
            }
            let literal = text.range(of: "literal").location
            XCTAssertNotEqual(spans.last(where: { NSLocationInRange(literal, $0.range) })?.color, 0x7ee787, "CDATA 不能作为标签解析")
        }
    }

    func testDockerShellCommandsKeepContinuationsAndExcludeExecStrings() async throws {
        let source = "# 前缀😀\nFROM alpine\nRUN --mount=type=cache,target=/tmp if true; then \\\n echo \"构建😀\"; fi\nCMD echo \"启动😀\"\nENTRYPOINT echo \"入口😀\"\nHEALTHCHECK CMD echo \"健康😀\"\nCMD [\"echo\", \"if then fi $HOME\"]\n"
        for (path, contents) in [("Dockerfile", source), ("README.md", "```dockerfile\n" + source + "```\n")] {
            let text = contents as NSString
            let spans = try await NativeDiffHighlighter.shared.highlight(contents, path: path)
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
            for word in ["构建😀", "启动😀", "入口😀", "健康😀", "if then fi $HOME"] {
                let offset = text.range(of: word).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, 0xa5d6ff, word)
            }
            let conditional = text.range(of: "if true").location
            XCTAssertEqual(spans.last(where: { NSLocationInRange(conditional, $0.range) })?.color, 0xff7b72)
            let ending = text.range(of: "; fi").location + 2
            XCTAssertEqual(spans.last(where: { NSLocationInRange(ending, $0.range) })?.color, 0xff7b72)
        }
    }

    func testMakefileBasenameConditionsAndRecipeStrings() async throws {
        let source = "# 注释😀\nMESSAGE := 你好😀\nifdef DEBUG\nexport MODE = debug\nendif\n.PHONY: all\nall:\n\t@echo \"完成😀\"\n"
        for path in ["Makefile", "build/makefile", "MAKEFILE"] {
            let text = source as NSString
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
            for (token, color): (String, UInt32) in [("注释😀", 0x8b949e), ("MESSAGE", 0x79c0ff), ("ifdef", 0xff7b72), ("export", 0xff7b72), (".PHONY", 0x79c0ff), ("完成😀", 0xa5d6ff)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, "\(path): \(token)")
            }
        }
        let unknown = try await NativeDiffHighlighter.shared.highlight(source, path: "Makefile.txt")
        XCTAssertTrue(unknown.isEmpty)
        let markdown = "前缀😀\n```makefile\n" + source + "```\n"
        let spans = try await NativeDiffHighlighter.shared.highlight(markdown, path: "README.md")
        let offset = (markdown as NSString).range(of: "ifdef").location
        XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, 0xff7b72)
    }

    func testDockerfileBasenameAndMarkdownFenceUseNativeGrammar() async throws {
        let source = "# 注释😀\nFROM alpine:3.20 AS builder\nWORKDIR /app\nENV MESSAGE=\"你好😀\"\nCMD [\"echo\", \"完成😀\"]\n"
        for path in ["Dockerfile", "containers/dockerfile", "DOCKERFILE"] {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
            for (token, color): (String, UInt32) in [("FROM", 0xff7b72), ("WORKDIR", 0xff7b72), ("完成😀", 0xa5d6ff), ("注释😀", 0x8b949e)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, "\(path): \(token)")
            }
        }
        let unknown = try await NativeDiffHighlighter.shared.highlight(source, path: "Dockerfile.txt")
        XCTAssertTrue(unknown.isEmpty, "与 Web 一样按完整文件名识别，不能误识别普通文本")
        let markdown = "前缀😀\n```dockerfile\n" + source + "```\n"
        let spans = try await NativeDiffHighlighter.shared.highlight(markdown, path: "README.md")
        let offset = (markdown as NSString).range(of: "FROM").location
        XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, 0xff7b72)
    }

    func testCSharpKeepsInterpolatedNumbersDistinctFromStringText() async throws {
        let source = "// 注释😀\npublic class Example { string text = $\"你好😀{42}\"; int Count() { return 7; } }"
        let text = source as NSString
        let spans = try await NativeDiffHighlighter.shared.highlight(source, path: "Example.CS")
        XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        for (token, color): (String, UInt32) in [("class", 0xff7b72), ("return", 0xff7b72), ("42", 0x79c0ff), ("你好😀", 0xa5d6ff), ("注释😀", 0x8b949e)] {
            let offset = text.range(of: token).location
            XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, token)
        }
    }

    func testRubyAndLuaPreserveUnicodeAndMultilineSyntax() async throws {
        let samples: [(String, String, [(String, UInt32)])] = [
            ("example.rb", "# 注释😀\ndef greet\n  text = \"你好😀\"\n  return 42\nend\n", [
                ("def", 0xff7b72), ("return", 0xff7b72), ("42", 0x79c0ff), ("你好😀", 0xa5d6ff), ("注释😀", 0x8b949e)
            ]),
            ("example.LUA", "-- 注释😀\nlocal text = [[多行\n你好😀]]\nfunction count()\n  return 42\nend\n", [
                ("local", 0xff7b72), ("function", 0xff7b72), ("42", 0x79c0ff), ("你好😀", 0xa5d6ff), ("注释😀", 0x8b949e)
            ])
        ]
        for (path, source, expected) in samples {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
            for (token, color) in expected {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, "\(path): \(token)")
            }
        }
    }

    func testCancellationDuringQueryCollectionDoesNotPublishPartialColors() async throws {
        let highlighter = NativeDiffHighlighter(parseTimeSlice: 0.001)
        let source = String(repeating: "let value = \"查询😀\"; // 注释\n", count: 50000)
        let request = Task { try await highlighter.highlight(source, path: "large.rs") }
        defer { request.cancel() }
        let deadline = ContinuousClock.now + .seconds(10)
        while await highlighter.queryYieldCount == 0 {
            guard ContinuousClock.now < deadline else { XCTFail("未进入查询收集阶段"); return }
            await Task.yield()
        }
        request.cancel()
        do {
            _ = try await request.value
            XCTFail("查询收集阶段取消后不能发布部分颜色")
        } catch is CancellationError {}
        let next = try await highlighter.highlight("{\"text\":\"下一份😀\"}", path: "next.json")
        XCTAssertTrue(next.contains { $0.color == 0xa5d6ff })
    }

    func testTimeSlicedParsingResumesAndCancellationAllowsNextRequest() async throws {
        let highlighter = NativeDiffHighlighter(parseTimeSlice: 0.001)
        let empty = try await highlighter.highlight("", path: "empty.rs")
        XCTAssertTrue(empty.isEmpty)
        let initialYields = await highlighter.parseYieldCount
        XCTAssertEqual(initialYields, 0)
        let complete = String(repeating: "let text = \"你好😀\";\n", count: 6000) + "return 42;"
        let spans = try await highlighter.highlight(complete, path: "complete.rs")
        let resumed = await highlighter.parseYieldCount
        XCTAssertGreaterThan(resumed, 0, "用真实解析超时证明结果来自续算")
        let last = (complete as NSString).range(of: "return", options: .backwards)
        XCTAssertTrue(spans.contains { $0.color == 0xff7b72 && $0.range == last }, "续算必须覆盖末尾，不能返回部分结果")
        let huge = String(repeating: "let text = \"长任务😀\";\n", count: 200000)
        let request = Task { try await highlighter.highlight(huge, path: "cancelled.rs") }
        defer { request.cancel() }
        let deadline = ContinuousClock.now + .seconds(5)
        while await highlighter.parseYieldCount == resumed {
            guard ContinuousClock.now < deadline else { XCTFail("解析未进入时间片"); return }
            await Task.yield()
        }
        request.cancel()
        do {
            _ = try await request.value
            XCTFail("取消的长解析不能发布结果")
        } catch is CancellationError {}
        let next = try await highlighter.highlight("return 7;", path: "next.rs")
        XCTAssertTrue(next.contains { $0.color == 0xff7b72 && $0.range == NSRange(location: 0, length: 6) })
    }

    func testUTF16ChunkBoundaryPreservesSurrogatePairAndFollowingSyntax() async throws {
        // 第一个 32 KiB 块恰好落在 emoji 的两个 UTF-16 码元之间。
        let prefix = "/*" + String(repeating: "中", count: 16381)
        XCTAssertEqual(prefix.utf16.count, 16383)
        let source = prefix + "😀结束*/\nconst message = \"后续😀\";\nreturn 42;"
        let spans = try await NativeDiffHighlighter(parseTimeSlice: 0.001).highlight(source, path: "boundary.js")
        let text = source as NSString
        let comment = text.range(of: prefix + "😀结束*/")
        XCTAssertTrue(spans.contains { $0.range == comment && $0.color == 0x8b949e })
        let value = text.range(of: "\"后续😀\"")
        XCTAssertTrue(spans.contains { $0.range == value && $0.color == 0xa5d6ff })
        let keyword = text.range(of: "return")
        XCTAssertTrue(spans.contains { $0.range == keyword && $0.color == 0xff7b72 })
        XCTAssertTrue(spans.allSatisfy { NSMaxRange($0.range) <= text.length })
    }

    func testMarkdownSeparatesInlineMarkupAndFencedLanguages() async throws {
        let source = """
        # 标题😀

        文本 `行内😀` 与 [链接](https://example.com/文档)

        ```rust
        // 代码😀
        fn main() { let text = "你好😀"; }
        ```

        ```unknown
        fn untouched() {}
        ```
        """
        for ext in ["md", "markdown", "MD"] {
            let text = source as NSString
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: "README." + ext)
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
            for (token, color): (String, UInt32) in [("标题😀", 0x79c0ff), ("行内😀", 0xa5d6ff), ("https://", 0x79c0ff), ("fn main", 0xff7b72), ("你好😀", 0xa5d6ff), ("代码😀", 0x8b949e)] {
                let offset = text.range(of: token).location
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, "\(ext): \(token)")
            }
            let unknown = text.range(of: "fn untouched").location
            XCTAssertNotEqual(spans.last(where: { NSLocationInRange(unknown, $0.range) })?.color, 0xff7b72)
        }
    }

    func testSwiftNativeGrammarHandlesAsyncDeclarationsAndUnicode() async throws {
        let source = "// 注释😀\nstruct Example {\n    let text = \"你好😀\"\n    func count() async throws -> Int { return 42 }\n}\n"
        let text = source as NSString
        let spans = try await NativeDiffHighlighter.shared.highlight(source, path: "Example.SWIFT")
        XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        for (token, color): (String, UInt32) in [("func", 0xff7b72), ("return", 0xff7b72), ("42", 0x79c0ff), ("你好😀", 0xa5d6ff), ("注释😀", 0x8b949e)] {
            let offset = text.range(of: token).location
            XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, token)
        }
    }

    func testYAMLAndTOMLKeepScalarColorsAfterOverlappingCaptures() async throws {
        let samples: [(String, String, [(String, UInt32)])] = [
            ("compose.yaml", "# 注释😀\nmessage: \"你好😀\"\ncount: 42\nready: true\nbody: |\n  多行😀\n", [
                ("注释😀", 0x8b949e), ("你好😀", 0xa5d6ff), ("42", 0x79c0ff), ("true", 0x79c0ff), ("多行😀", 0xa5d6ff)
            ]),
            ("pipeline.YML", "name: build\nsteps:\n  - run: echo test\n", [("build", 0xa5d6ff)]),
            ("Cargo.toml", "# 注释😀\n[package]\nname = \"你好😀\"\ncount = 42\nready = true\n", [
                ("注释😀", 0x8b949e), ("你好😀", 0xa5d6ff), ("42", 0x79c0ff), ("true", 0x79c0ff)
            ])
        ]
        for (path, source, expected) in samples {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
            for (token, color) in expected {
                let offset = text.range(of: token).location
                // 文档按返回顺序覆盖颜色，检查最后生效的 capture，避免仅有正确 capture 却被覆盖。
                XCTAssertEqual(spans.last(where: { NSLocationInRange(offset, $0.range) })?.color, color, "\(path): \(token)")
            }
        }
    }

    func testCPPAndJavaIncludeBaseSyntaxAndUnicodeStrings() async throws {
        let cpp = "// 注释😀\ntemplate<typename T> class Box { public: const char *value = R\"(你好😀)\"; int count() { return 42; } };"
        for ext in ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "CPP"] {
            let spans = try await NativeDiffHighlighter.shared.highlight(cpp, path: "box." + ext)
            let text = cpp as NSString
            for (token, color): (String, UInt32) in [("template", 0xff7b72), ("return", 0xff7b72), ("42", 0x79c0ff), ("你好😀", 0xa5d6ff), ("注释😀", 0x8b949e)] {
                XCTAssertTrue(spans.contains { $0.color == color && text.substring(with: $0.range).contains(token) }, "\(ext): \(token)")
            }
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
        }
        let java = "// 注释😀\npublic class Example { String text = \"你好😀\"; int count() { return 42; } }"
        let spans = try await NativeDiffHighlighter.shared.highlight(java, path: "Example.java")
        let text = java as NSString
        for (token, color): (String, UInt32) in [("class", 0xff7b72), ("return", 0xff7b72), ("42", 0x79c0ff), ("你好😀", 0xa5d6ff), ("注释😀", 0x8b949e)] {
            XCTAssertTrue(spans.contains { $0.color == color && text.substring(with: $0.range).contains(token) }, token)
        }
        XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
    }

    func testHTMLHighlightsEmbeddedCodeWithoutExecutingOrMisreadingMarkup() async throws {
        let source = """
        <p>前缀😀</p>
        <!-- <script>const hidden = 1;</script> -->
        <script type="module">const message = "你好😀";</script>
        <style>.card { width: 12px; content: "样式😀"; }</style>
        <script type="application/ld+json">{"message":"数据😀","count":42}</script>
        <script type="text/template">const untouched = 123;</script>
        <style type="text/less">@unchanged: 4;</style>
        """
        let text = source as NSString
        let spans = try await NativeDiffHighlighter.shared.highlight(source, path: "index.html")
        for (token, color): (String, UInt32) in [("const message", 0xff7b72), ("12", 0x79c0ff), ("数据😀", 0xa5d6ff), ("样式😀", 0xa5d6ff)] {
            let expected = text.range(of: token)
            XCTAssertTrue(spans.contains { $0.color == color && NSIntersectionRange($0.range, expected).length > 0 }, token)
        }
        for token in ["const hidden", "const untouched", "@unchanged"] {
            let range = text.range(of: token)
            XCTAssertFalse(spans.contains { $0.color == 0xff7b72 && NSIntersectionRange($0.range, range).length > 0 }, token)
        }
        XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length })
    }

    func testCSSAndHTMLUseNativeSemanticColorsAndUnicodeRanges() async throws {
        let samples: [(String, String, [(String, UInt32)])] = [
            ("theme.CSS", "/* 注释😀 */\n.card { color: red; content: \"你好😀\"; width: 12px; }", [
                ("注释😀", 0x8b949e), ("color", 0x79c0ff), ("你好😀", 0xa5d6ff), ("12", 0x79c0ff)
            ]),
            ("index.html", "<!-- 注释😀 -->\n<section title=\"你好😀\"><p>文本</p></section>", [
                ("注释😀", 0x8b949e), ("section", 0x7ee787), ("title", 0x79c0ff), ("你好😀", 0xa5d6ff)
            ]),
            ("legacy.htm", "<a href=\"/文档😀\">链接</a>", [("href", 0x79c0ff), ("/文档😀", 0xa5d6ff)])
        ]
        for (path, source, expected) in samples {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length }, path)
            for (token, color) in expected {
                XCTAssertTrue(spans.contains { $0.color == color && text.substring(with: $0.range).contains(token) }, "\(path): \(token)")
            }
        }
    }

    @MainActor func testLargeDiffMapsAllRowsWhileMainActorRemainsAvailable() async throws {
        let lines = (0..<6000).map { index in
            DiffLine(id: index, text: "let value_\(index) = \"你好😀\"; // comment", kind: "+", old: nil, new: index + 1)
        }
        let file = DiffFile(path: "large.rs", lines: lines)
        var heartbeats = 0
        let heartbeat = Task { @MainActor in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(2)) } catch { return }
                heartbeats += 1
            }
        }
        defer { heartbeat.cancel() }
        let start = ContinuousClock.now
        let highlighted = try await NativeDiffHighlighter.shared.highlight(file)
        let elapsed = start.duration(to: .now)
        XCTAssertEqual(highlighted.count, lines.count)
        for line in lines {
            XCTAssertTrue(highlighted[line.id, default: []].contains { $0.color == 0xff7b72 && $0.range == NSRange(location: 0, length: 3) })
        }
        print("原生高亮 6000 行：\(elapsed)，主线程心跳 \(heartbeats)")
        XCTAssertGreaterThan(heartbeats, 0, "后台高亮期间主线程应仍能执行任务")
    }

    func testDiffVersionsAndSeparatedHunksDoNotShareStringState() async throws {
        let file = DiffFile(path: "example.py", lines: [
            DiffLine(id: 0, text: "@@ -1,3 +1,3 @@", kind: "@", old: nil, new: nil),
            DiffLine(id: 1, text: "value = \"\"\"旧😀", kind: "-", old: 1, new: nil),
            DiffLine(id: 2, text: "value = \"\"\"新😀", kind: "+", old: nil, new: 1),
            DiffLine(id: 3, text: "结束\"\"\"", kind: " ", old: 2, new: 2),
            DiffLine(id: 4, text: "return 42", kind: " ", old: 3, new: 3),
            DiffLine(id: 5, text: "@@ -20 +20 @@", kind: "@", old: nil, new: nil),
            DiffLine(id: 6, text: "text = \"\"\"fragment", kind: "+", old: nil, new: 20),
            DiffLine(id: 7, text: "@@ -40 +40 @@", kind: "@", old: nil, new: nil),
            DiffLine(id: 8, text: "def greet(): pass", kind: "+", old: nil, new: 40)
        ])
        let highlighted = try await NativeDiffHighlighter.shared.highlight(file)
        for id in [1, 2, 3] {
            XCTAssertTrue(highlighted[id, default: []].contains { $0.color == 0xa5d6ff }, "第 \(id) 行应为字符串")
        }
        for (id, keyword) in [(4, "return"), (8, "def")] {
            let text = file.lines.first { $0.id == id }!.text as NSString
            XCTAssertTrue(highlighted[id, default: []].contains { $0.color == 0xff7b72 && text.substring(with: $0.range) == keyword })
        }
        for line in file.lines {
            XCTAssertTrue(highlighted[line.id, default: []].allSatisfy { NSMaxRange($0.range) <= line.text.utf16.count })
        }
    }

    func testAdditionalNativeLanguagesPreserveUnicodeRangesAndSemanticColors() async throws {
        let samples: [(String, String, String)] = [
            ("main.rs", "// 注释😀\nfn main() { let text = \"你好😀\"; }", "fn"),
            ("main.py", "# 注释😀\ndef greet():\n    return \"你好😀\"\n", "def"),
            ("main.go", "package main\n// 注释😀\nfunc main() { text := \"你好😀\"; _ = text }", "func"),
            ("main.c", "// 注释😀\nint main() { const char *text = \"你好😀\"; return 0; }", "return"),
            ("main.sh", "# 注释😀\nif true; then echo \"你好😀\"; fi", "if")
        ]
        for (path, source, keyword) in samples {
            let spans = try await NativeDiffHighlighter.shared.highlight(source, path: path)
            let text = source as NSString
            XCTAssertTrue(spans.allSatisfy { $0.range.location >= 0 && NSMaxRange($0.range) <= text.length }, path)
            XCTAssertTrue(spans.contains { $0.color == 0x8b949e && text.substring(with: $0.range).contains("注释😀") }, path)
            XCTAssertTrue(spans.contains { $0.color == 0xff7b72 && text.substring(with: $0.range) == keyword }, path)
            XCTAssertTrue(spans.contains { $0.color == 0xa5d6ff && text.substring(with: $0.range).contains("你好😀") }, path)
        }
        let json = "{\"message\": \"你好😀\", \"count\": 42, \"ready\": true}"
        let spans = try await NativeDiffHighlighter.shared.highlight(json, path: "settings.json")
        XCTAssertTrue(spans.contains { $0.color == 0x79c0ff && (json as NSString).substring(with: $0.range) == "42" })
        XCTAssertTrue(spans.contains { $0.color == 0xa5d6ff && (json as NSString).substring(with: $0.range).contains("你好😀") })
        let profile = try await NativeDiffHighlighter.shared.highlight("export VALUE=42", path: "/home/test/.bashrc")
        XCTAssertFalse(profile.isEmpty)
    }

    func testNativeParsingHandlesMultilineUnicodeAndTSX() async throws {
        let source = "/* 注释😀\n继续 */\nconst answer: number = 42;\nconst label = \"你好\";"
        let spans = try await NativeDiffHighlighter.shared.highlight(source, path: "example.ts")
        let text = source as NSString
        XCTAssertTrue(spans.contains { $0.color == 0x8b949e && text.substring(with: $0.range).contains("继续") })
        XCTAssertTrue(spans.contains { $0.color == 0xff7b72 && text.substring(with: $0.range) == "const" })
        XCTAssertTrue(spans.contains { $0.color == 0xa5d6ff && text.substring(with: $0.range).contains("你好") })
        let jsx = "const View = () => <div title=\"你好\">hello</div>;"
        for path in ["view.tsx", "view.jsx"] {
            let highlighted = try await NativeDiffHighlighter.shared.highlight(jsx, path: path)
            XCTAssertFalse(highlighted.isEmpty)
            XCTAssertTrue(highlighted.allSatisfy { NSMaxRange($0.range) <= jsx.utf16.count })
        }
        let unknown = try await NativeDiffHighlighter.shared.highlight(source, path: "unknown.xyz")
        XCTAssertTrue(unknown.isEmpty)
    }
}
