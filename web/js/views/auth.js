import { h } from "../dom.js";
import { state, signIn, signUp, unlock, signOut } from "../store.js";
import { navigate } from "../router.js";
const COPY = {
    signin: { heading: "Sign In", lead: "Sign in to your download Library.", button: "Sign In", busy: "Signing In…" },
    signup: { heading: "Create Your Library", lead: "One account keeps every download, its speed and your preferences in one place.", button: "Create Account", busy: "Creating…" },
    unlock: { heading: "Unlock Your Library", lead: "Enter your password to decrypt your history on this browser.", button: "Unlock", busy: "Unlocking…" }
};
function field({ id, label, type, autocomplete, value = "", readOnly = false }) {
    const input = h("input", { id, type, autocomplete, value, required: true, spellcheck: "false", autocapitalize: "off", readonly: readOnly || null });
    return { input, element: h("div", { class: "field" }, h("label", { for: id }, label), input) };
}
export function mount(root, { mode, next }) {
    const copy = COPY[mode];
    document.title = `${copy.heading} · MP4 Grabber`;
    const email = field({ id: "email", label: "Email", type: "email", autocomplete: "username", value: mode === "unlock" ? state.user.email : mode === "signup" ? state.setupEmail : "", readOnly: mode === "unlock" || (mode === "signup" && Boolean(state.setupEmail)) });
    const password = field({ id: "password", label: "Password", type: "password", autocomplete: mode === "signup" ? "new-password" : "current-password" });
    const confirm = mode === "signup" ? field({ id: "confirm", label: "Confirm password", type: "password", autocomplete: "new-password" }) : null;
    const error = h("p", { class: "auth-error", role: "alert", hidden: true });
    const submit = h("button", { class: "button primary large wide", type: "submit" }, copy.button);
    const form = h("form", { novalidate: true }, h("div", { class: "group auth-fields" }, mode === "unlock" ? null : email.element, password.element, confirm?.element), error, mode === "signup" ? h("p", { class: "auth-note footnote" }, "Your password also encrypts your history, so the server can't read what you download. If you forget it, the history can't be recovered.") : null, submit);
    function fail(message) {
        error.textContent = message;
        error.hidden = false;
        submit.disabled = false;
        submit.textContent = copy.button;
    }
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        error.hidden = true;
        const emailValue = email.input.value.trim();
        const passwordValue = password.input.value;
        if (mode !== "unlock" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue))
            return fail("Enter a valid email address.");
        if (!passwordValue)
            return fail("Enter your password.");
        if (mode === "signup") {
            if (passwordValue.length < 10)
                return fail("Use at least 10 characters. A short sentence is easy to remember and hard to guess.");
            if (passwordValue !== confirm.input.value)
                return fail("The passwords don't match.");
        }
        submit.disabled = true;
        submit.textContent = copy.busy;
        try {
            if (mode === "signup")
                await signUp(emailValue, passwordValue);
            else if (mode === "signin")
                await signIn(emailValue, passwordValue);
            else
                await unlock(passwordValue);
            navigate(next || "/library", { replace: true });
        }
        catch (problem) {
            fail(problem.message);
            password.input.select();
        }
    });
    const footer = [];
    if (mode === "signin" && state.signupOpen)
        footer.push(h("p", { class: "auth-switch" }, "New here? ", h("a", { href: "/signup" }, "Create your Library")));
    if (mode === "signup")
        footer.push(h("p", { class: "auth-switch" }, "Already have an account? ", h("a", { href: "/signin" }, "Sign in")));
    if (mode === "unlock") {
        footer.push(h("p", { class: "auth-switch" }, `Signed in as ${state.user.email}. `, h("a", { href: "/signin", onClick: async (event) => {
                event.preventDefault();
                await signOut();
            } }, "Sign out")));
    }
    root.replaceChildren(h("div", { class: "auth" }, h("div", { class: "auth-card" }, h("img", { class: "app-icon", src: "/icons/logo.svg", alt: "", width: 76, height: 76 }), h("h1", {}, copy.heading), h("p", { class: "lead" }, copy.lead), form, footer, mode === "signin" ? h("p", { class: "auth-footer caption" }, "Your password protects your encrypted history. Keep it somewhere safe.") : null)));
    (mode === "unlock" ? password.input : email.input).focus();
    return {};
}
