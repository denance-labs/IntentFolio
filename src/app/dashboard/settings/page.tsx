import { redirect } from "next/navigation";

// The Settings tab is hidden (016 Q4); old links and bookmarks land on Overview, the default tab (D-518).
export default function SettingsPage() {
  redirect("/dashboard/overview");
}
