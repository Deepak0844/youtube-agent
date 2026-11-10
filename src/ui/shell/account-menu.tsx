"use client";

import Link from "next/link";
import { useRef } from "react";
import { CircleUser } from "lucide-react";
import { cn, fade, focusRing } from "../lib/cn";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../primitives/dropdown-menu";

/** Account menu: the Account page and Sign out. `signOut` is the logout server action, passed from the server layout. */
export function AccountMenu({ signOut }: { signOut: () => Promise<void> }) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <>
      <form ref={form} action={signOut} hidden />
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Account"
          className={cn("flex size-11 items-center justify-center rounded-control text-muted hover:text-text md:size-9", fade, focusRing)}
        >
          <CircleUser size={20} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href="/settings/account">Account</Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => form.current?.requestSubmit()}>Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
