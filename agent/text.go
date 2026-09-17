package main

import (
	"fmt"
	"log"
	"strings"
	"unicode"
	"unicode/utf8"
)

// printable makes text from the network or the controller safe to log: line
// breaks and other spacing become plain spaces, and anything a terminal or
// log viewer could act on (ESC, BEL, bidi overrides) is dropped, so a
// response can neither forge log lines nor rewrite what an admin sees.
func printable(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case unicode.IsSpace(r):
			return ' '
		case unicode.IsPrint(r):
			return r
		}
		return -1
	}, s)
}

// logf is log.Printf for every line that may carry text we did not write.
func logf(format string, args ...any) {
	log.Print(printable(fmt.Sprintf(format, args...)))
}

// checkText refuses characters that a line-based check and the program that
// reads the file could see differently: control characters other than tab
// and newline (bash drops NUL, CR and ESC hide text from a reader), invalid
// UTF-8 and invisible formatting characters. Comment lines, whose first
// non-blank character is '#', may hold any printable text; with asciiOnly,
// every other line must be printable ASCII.
func checkText(what, text string, asciiOnly bool) error {
	if !utf8.ValidString(text) {
		return fmt.Errorf("refusing %s: it is not valid UTF-8", what)
	}
	for n, line := range strings.Split(text, "\n") {
		comment := strings.HasPrefix(strings.TrimLeft(line, " \t"), "#")
		for _, r := range line {
			switch {
			case r == '\t' || (r >= 0x20 && r < 0x7f):
			case r < 0x80 || !unicode.IsPrint(r):
				return fmt.Errorf("refusing %s: line %d contains the non-printing character %U", what, n+1, r)
			case asciiOnly && !comment:
				return fmt.Errorf("refusing %s: line %d contains the non-ASCII character %U", what, n+1, r)
			}
		}
	}
	return nil
}

// asciiLower lower-cases ASCII letters only, so no other script's letter
// can fold into a key we compare against.
func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + 'a' - 'A'
		}
	}
	return string(b)
}
