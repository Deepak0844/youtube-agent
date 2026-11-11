import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { EmptyState } from "@/ui/states/empty-state";

export default function NotFound() {
  return (
    <EmptyState
      icon={FileQuestion}
      title="Page not found"
      body="The link may be old, or the item was deleted."
      action={
        <Button asChild variant="secondary">
          <Link href="/">Go home</Link>
        </Button>
      }
    />
  );
}
