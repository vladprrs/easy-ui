import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { LoginPage } from "./LoginPage";
import { AuthProvider } from "./AuthContext";

describe("LoginPage", () => {
  it("renders the Russian login form", async () => {
    const router = createMemoryRouter([{ path: "/login", element: <AuthProvider><LoginPage /></AuthProvider> }], { initialEntries: ["/login?next=%2Flibrary"] });
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole("heading", { name: "Вход" })).toBeTruthy();
    expect(screen.getByLabelText("Имя")).toBeTruthy();
    expect(screen.getByLabelText("Пароль").getAttribute("type")).toBe("password");
    expect(screen.getByRole("button", { name: "Войти" })).toBeTruthy();
  });
});
