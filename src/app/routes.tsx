import { Navigate, Route, Routes } from "react-router";
import { SmokeSpec } from "../smoke/SmokeSpec";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/debug" element={<SmokeSpec />} />
      <Route path="*" element={<Navigate to="/debug" replace />} />
    </Routes>
  );
}
