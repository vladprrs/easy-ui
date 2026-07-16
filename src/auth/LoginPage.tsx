import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ApiError, login, validateNextPath } from "../api/client";
import { headingPage, inputBase, kicker, pillPrimary, plate } from "../app/chrome";
import { useDocumentTitle } from "../app/useDocumentTitle";
import { useAuth } from "./AuthContext";

export function LoginPage() {
  useDocumentTitle("Вход");
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [searchParams] = useSearchParams();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const next = validateNextPath(searchParams.get("next")) ?? "/";
    try {
      const result = await login({ name, password, ...(next === "/" ? {} : { next }) });
      setUser(result.user);
      navigate(validateNextPath(result.next) ?? next, { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 401
        ? "Неверное имя или пароль"
        : "Не удалось войти. Попробуйте ещё раз.");
    } finally {
      setSubmitting(false);
    }
  }

  return <main className="flex min-h-dvh items-center justify-center bg-eui-lav px-6 py-12">
    <section className={`${plate} w-full max-w-md bg-white`}>
      <p className={kicker}>easy-ui</p>
      <h1 className={`${headingPage} mt-2`}>Вход</h1>
      <form className="mt-8 space-y-5" onSubmit={submit}>
        <label className="block text-sm font-medium">Имя
          <input className={`${inputBase} mt-1.5 w-full`} autoComplete="username" autoFocus required maxLength={64} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="block text-sm font-medium">Пароль
          <input className={`${inputBase} mt-1.5 w-full`} type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {error ? <p className="text-sm text-eui-magenta" role="alert">{error}</p> : null}
        <button className={`${pillPrimary} w-full`} type="submit" disabled={submitting}>{submitting ? "Входим…" : "Войти"}</button>
      </form>
    </section>
  </main>;
}
