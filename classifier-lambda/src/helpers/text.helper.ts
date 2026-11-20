const SENTENCE = /[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g;

export class TextHelper {
  static normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  static truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;

    const slice = text.slice(0, maxChars);
    const lastSpace = slice.lastIndexOf(' ');
    const cut = lastSpace > maxChars * 0.8 ? slice.slice(0, lastSpace) : slice;

    return cut.trimEnd() + '…';
  }

  static firstSentences(text: string, count: number): string {
    const sentences = text.match(SENTENCE) ?? [text];

    return sentences
      .slice(0, count)
      .map((sentence) => sentence.trim())
      .join(' ');
  }
}
