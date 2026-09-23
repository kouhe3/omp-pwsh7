/**
 * PowerShell syntax highlighting: Shiki's TextMate grammar with a theme that
 * maps its scopes onto the OMP semantic colors (comments, strings, variables,
 * cmdlets, operators, numbers, types), preloaded in the background so the first
 * card is never drawn as plain text.
 */
import { createHighlighter, type HighlighterGeneric } from "shiki";
import type { Theme } from "./card";

export const OMP_SYNTAX_THEME = {
  name: "omp-syntax",
  type: "dark" as const,
  fg: "default",
  bg: "transparent",
  settings: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "syntaxComment" },
    },
    {
      scope: ["string", "punctuation.definition.string", "string.quoted"],
      settings: { foreground: "syntaxString" },
    },
    {
      scope: [
        "variable",
        "support.variable",
        "punctuation.definition.variable",
      ],
      settings: { foreground: "syntaxVariable" },
    },
    {
      scope: ["keyword", "storage.type", "storage.modifier", "keyword.control"],
      settings: { foreground: "syntaxKeyword" },
    },
    {
      scope: ["keyword.operator"],
      settings: { foreground: "syntaxOperator" },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "entity.name.command",
      ],
      settings: { foreground: "syntaxFunction" },
    },
    {
      scope: ["constant.numeric"],
      settings: { foreground: "syntaxNumber" },
    },
    {
      scope: [
        "entity.name.type",
        "support.class",
        "storage.type.powershell",
        "storage.type.cs",
      ],
      settings: { foreground: "syntaxType" },
    },
    {
      scope: [
        "punctuation.section",
        "punctuation.separator",
        "punctuation.terminator",
      ],
      settings: { foreground: "syntaxPunctuation" },
    },
  ],
};

let cachedHighlighter: HighlighterGeneric<any, any> | null = null;

let highlighterPromise: Promise<HighlighterGeneric<any, any>> | null = null;

export async function getHighlighterInstance(): Promise<
  HighlighterGeneric<any, any>
> {
  if (cachedHighlighter) return cachedHighlighter;
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [OMP_SYNTAX_THEME],
      langs: ["powershell"],
    }).then((h) => {
      cachedHighlighter = h;
      return h;
    });
  }
  return highlighterPromise;
}

// Eager background preloading
getHighlighterInstance().catch(() => {});

/** Highlight a PowerShell command line, returning one ANSI-colored string per line. */
export function highlightPowerShell(code: string, theme: Theme): string[] {
  if (!cachedHighlighter) {
    return code.split("\n");
  }
  try {
    const result = cachedHighlighter.codeToTokens(code, {
      lang: "powershell",
      theme: "omp-syntax",
    });
    return result.tokens.map((line) =>
      line
        .map((token) => {
          const color = token.color;
          if (color && color !== "default" && typeof theme.fg === "function") {
            return theme.fg(color, token.content);
          }
          return token.content;
        })
        .join(""),
    );
  } catch {
    return code.split("\n");
  }
}
