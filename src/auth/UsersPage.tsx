import { useEffect, useState, type FormEvent } from "react";
import { Navigate } from "react-router";
import { ApiError, createUser, listUsers, type UserSummary } from "../api/client";
import { headingPage, inputBase, kicker, pillPrimary, plate } from "../app/chrome";
import { useDocumentTitle } from "../app/useDocumentTitle";
import { useAuth } from "./AuthContext";

export function UsersPage() {
  useDocumentTitle("Пользователи");
  const { user, loading: authLoading } = useAuth();
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!user?.isAdmin) return;
    const controller = new AbortController();
    void listUsers(controller.signal)
      .then((result) => setUsers(result.users))
      .catch((caught: unknown) => {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) setError("Не удалось загрузить пользователей.");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [user]);

  if (authLoading) return <main className="px-6 py-12 text-sm text-eui-slate-500">Загрузка…</main>;
  if (!user) return <Navigate to="/login?next=%2Fusers" replace />;
  if (!user.isAdmin) return <Navigate to="/" replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setCreating(true);
    setError(null);
    try {
      const created = await createUser({
        name: String(form.get("name") ?? ""),
        password: String(form.get("password") ?? ""),
        isAdmin: form.get("isAdmin") === "on",
      });
      setUsers((current) => [...current, created]);
      formElement.reset();
    } catch (caught) {
      setError(caught instanceof ApiError && caught.code === "already_exists"
        ? "Пользователь с таким именем уже существует."
        : "Не удалось создать пользователя.");
    } finally {
      setCreating(false);
    }
  }

  return <main className="mx-auto max-w-screen-xl px-6 py-10">
    <p className={kicker}>Администрирование</p>
    <h1 className={`${headingPage} mt-2`}>Пользователи</h1>
    <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section className={plate}>
        <h2 className="font-eui-display text-xl font-medium">Список пользователей</h2>
        {loading ? <p className="mt-4 text-sm text-eui-slate-500">Загрузка…</p> : <ul className="mt-4 divide-y divide-eui-ink/10">
          {users.map((item) => <li className="flex items-center gap-3 py-3" key={item.id}>
            <span className="font-medium">{item.name}</span>
            {item.isAdmin ? <span className="rounded-full bg-eui-lilac-100 px-2 py-0.5 text-xs">Администратор</span> : null}
            <time className="ml-auto text-xs text-eui-slate-500" dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleDateString("ru-RU")}</time>
          </li>)}
        </ul>}
      </section>
      <section className={`${plate} bg-white`}>
        <h2 className="font-eui-display text-xl font-medium">Новый пользователь</h2>
        <form className="mt-5 space-y-4" onSubmit={submit}>
          <label className="block text-sm font-medium">Имя<input className={`${inputBase} mt-1.5 w-full`} name="name" required maxLength={64} /></label>
          <label className="block text-sm font-medium">Пароль<input className={`${inputBase} mt-1.5 w-full`} name="password" type="password" required minLength={8} maxLength={256} autoComplete="new-password" /></label>
          <label className="flex items-center gap-2 text-sm"><input name="isAdmin" type="checkbox" /> Администратор</label>
          {error ? <p className="text-sm text-eui-magenta" role="alert">{error}</p> : null}
          <button className={pillPrimary} type="submit" disabled={creating}>{creating ? "Создаём…" : "Создать"}</button>
        </form>
      </section>
    </div>
  </main>;
}
