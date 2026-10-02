// Which side of the sign-in dialog to open first. Set right before setDialog("login"): the inline
// "Log in / Create account" prompts know whether the person wants to sign up or just come back.
export type AuthIntent = "login" | "signup";
let intent: AuthIntent = "login";
export function setAuthIntent(next: AuthIntent) {
  intent = next;
}
export function getAuthIntent(): AuthIntent {
  return intent;
}
