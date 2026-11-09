import { format } from 'prettier/standalone';
import html from 'prettier/plugins/html';

self.addEventListener('message', async (event: MessageEvent<string>) => {
  try {
    const text = await format(event.data, {
      parser: 'html',
      plugins: [html],
      embeddedLanguageFormatting: 'off',
    });
    self.postMessage(text.length <= 1_000_000 ? text : null);
  } catch {
    self.postMessage(null);
  }
});
