/**
 * Root → sign-in. (After T1.11: signed-in users go straight to their console.)
 */
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/login");
}
