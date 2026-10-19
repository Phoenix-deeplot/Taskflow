import { requireChatGPTUser } from "@/app/chatgpt-auth";
import Workbench from "@/app/workbench";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");
  return <Workbench user={{ name: user.displayName, email: user.email }} />;
}
