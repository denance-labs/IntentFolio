import { redirect } from "next/navigation";

export default function MockDashboardIndexPage() {
  redirect("/mock-dashboard/overview");
}
