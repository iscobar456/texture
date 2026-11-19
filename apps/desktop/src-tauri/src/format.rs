//! Format document: the `tex-fmt` crate behind the `format_tex` command.

use std::path::PathBuf;

/// Stand-ins for characters that must not count as nesting when tex-fmt indents (Unicode private use, one char each).
const FMT_STANDINS: [(char, char); 6] = [
    ('(', '\u{E000}'), (')', '\u{E001}'), ('[', '\u{E002}'), (']', '\u{E003}'), ('{', '\u{E004}'), ('}', '\u{E005}'),
];

/// tex-fmt indents after every `(`, `[` and `{` it sees, so ordinary prose breaks it: the label in `\item[ii)]`,
/// a list marker like `a)`, a half-open interval `[0, 1)`, `\\[2pt]`, or `\left\{ ... \right.`. In LaTeX only braces
/// and environments nest (plus `\[ \]` and `\( \)`), so before formatting this swaps the rest for stand-ins:
/// `(` `)` always, `[` `]` unless escaped (`\[`, `\]`), and escaped braces `\{` `\}` (they never open a group).
/// An odd run of backslashes before a character means it is escaped.
fn protect_delimiters(text: &str, restore: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut slashes = 0usize;
    for c in text.chars() {
        let escaped = slashes % 2 == 1;
        let mapped = if restore {
            FMT_STANDINS.iter().find(|(_, s)| *s == c).map(|(o, _)| *o)
        } else {
            match c {
                '(' | ')' if !escaped => Some(c),
                '[' | ']' if !escaped => Some(c),
                '{' | '}' if escaped => Some(c),
                _ => None,
            }
            .and_then(|c| FMT_STANDINS.iter().find(|(o, _)| *o == c).map(|(_, s)| *s))
        };
        out.push(mapped.unwrap_or(c));
        slashes = if c == '\\' { slashes + 1 } else { 0 };
    }
    out
}

/// Formats LaTeX with the `tex-fmt` crate. `indent` is "2", "4" or "tab". tex-fmt panics on input it cannot make
/// sense of (unbalanced environments, for one), so that is caught and returned as an error message.
#[tauri::command(async)]
pub fn format_tex(text: String, wrap: bool, wraplen: u32, indent: String) -> Result<String, String> {
    use tex_fmt::args::{Args, OptionArgs};
    use tex_fmt::config::get_config_args;
    use tex_fmt::format::format_file;
    use merge::Merge;

    if text.chars().any(|c| FMT_STANDINS.iter().any(|(_, s)| *s == c)) {
        return Err("the document contains characters from the Unicode private-use area (U+E000 to U+E005)".into());
    }
    let text = protect_delimiters(&text, false);
    let (tabchar, tabsize) = match indent.as_str() {
        "tab" => ("tab", 1),
        "4" => ("space", 4),
        _ => ("space", 2),
    };
    let config = format!(
        "wrap = {wrap}\nwraplen = {}\ntabsize = {tabsize}\ntabchar = \"{tabchar}\"\n",
        wraplen.clamp(20, 300)
    );
    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut opts = get_config_args(Some((PathBuf::new(), String::new(), config))).unwrap();
        opts.merge(OptionArgs::default());
        let mut args = Args::from(opts);
        args.stdin = true;
        let mut logs = Vec::new();
        args.resolve(&mut logs);
        let out = format_file(&text, std::path::Path::new("input"), &args, &mut logs);
        // tex-fmt reports a document whose \begin/\end or braces do not balance only as indentation warnings
        // ("Indent is negative", "Indent does not return to zero"). Indenting such a document would just spread
        // the confusion, so treat those like errors and leave the text alone.
        let errors: Vec<String> = logs
            .iter()
            .filter(|l| l.level == log::Level::Error || (l.level == log::Level::Warn && l.message.contains("ndent")))
            .map(|l| match l.linum_old {
                Some(n) => format!("line {n}: {}", l.message.trim_end_matches('.')),
                None => l.message.trim_end_matches('.').to_string(),
            })
            .collect();
        (out, errors)
    }));
    match run {
        Ok((_, errors)) if !errors.is_empty() => Err(errors.join("; ")),
        Ok((out, _)) => Ok(protect_delimiters(&out, true)),
        Err(_) => Err("tex-fmt could not make sense of this document".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::format_tex;

    #[test]
    fn indents_and_keeps_long_lines_when_wrap_is_off() {
        let src = "\\documentclass{article}\n\\begin{document}\n\\begin{itemize}\n\\item one   \n\\item two\n\\end{itemize}\nA very long line of prose that goes on and on well past the eighty column mark for sure yes.\n\\end{document}\n";
        let out = format_tex(src.into(), false, 80, "2".into()).unwrap();
        assert!(out.contains("\n  \\item one\n"), "{out}");
        assert!(out.contains("goes on and on well past the eighty column mark for sure yes.\n"), "{out}");
    }

    #[test]
    fn wraps_when_asked() {
        let src = "\\begin{document}\nA very long line of prose that goes on and on well past the eighty column mark for sure yes.\n\\end{document}\n";
        let out = format_tex(src.into(), true, 40, "4".into()).unwrap();
        assert!(out.lines().all(|l| l.len() <= 40), "{out}");
    }

    #[test]
    fn unbalanced_input_is_refused() {
        let r = format_tex("\\begin{document}\n\\begin{itemize}\n\\end{document}\n".into(), false, 80, "2".into());
        assert!(r.is_err(), "{r:?}");
        let r = format_tex("\\end{foo}\n}\n".into(), false, 80, "2".into());
        assert!(r.is_err(), "{r:?}");
    }

    #[test]
    fn prose_with_stray_delimiters_does_not_break_indentation() {
        let src = "\\begin{document}\n\\begin{enumerate}\n\\item[ii)] Show that\ni) Verify\n[0, 1) is half open\n\\begin{align*}\nx &= 1 \\\\[2pt]\ny &= \\left\\{ 1 \\right.\n\\end{align*}\n\\end{enumerate}\n\\end{document}\n";
        let out = format_tex(src.into(), false, 80, "2".into()).unwrap();
        assert!(out.contains("\n  \\item[ii)] Show that\n"), "{out}");
        assert!(out.contains("\n    \\begin{align*}\n"), "{out}");
        assert!(out.contains("\\left\\{ 1 \\right."), "{out}");
        assert!(out.ends_with("\\end{document}\n"), "{out}");
    }

    #[test]
    fn display_math_brackets_still_nest() {
        let src = "\\begin{document}\n\\[\nx = 1\n\\]\n\\end{document}\n";
        let out = format_tex(src.into(), false, 80, "2".into()).unwrap();
        assert!(out.contains("\\[\n  x = 1\n\\]"), "{out}");
    }

    #[test]
    fn a_line_too_long_to_wrap_is_not_an_error() {
        let long = "x".repeat(100);
        let src = format!("\\begin{{document}}\n{long}\n\\end{{document}}\n");
        assert!(format_tex(src, true, 40, "2".into()).is_ok());
    }
}
