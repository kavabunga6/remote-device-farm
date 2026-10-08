// Exactly 64 symbols: six random bits select each character without modulo bias.
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*?';
const categories = [/[A-Z]/, /[a-z]/, /[2-9]/, /[!@#$%^&*?]/];

export function generatePassword(): string {
  const bytes = new Uint8Array(20);
  let password: string;
  do {
    crypto.getRandomValues(bytes);
    password = Array.from(bytes, byte => alphabet[byte & 63]).join('');
  } while (!categories.every(pattern => pattern.test(password)));
  return password;
}
