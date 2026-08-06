"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { quotes } from "@/lib/quotes";
import { copy } from "@/lib/copy";

/** Pick a random quote, avoiding an immediate repeat of `previous`. */
function pickQuote(previous: number | null): number {
  if (quotes.length <= 1) return 0;
  let i = Math.floor(Math.random() * quotes.length);
  // Nudge away from the one just shown so "یکی دیگه" always feels fresh.
  if (i === previous) i = (i + 1) % quotes.length;
  return i;
}

/**
 * The "انگیزه" control: a button that opens a dialog with a random
 * motivational quote and its speaker, plus a "یکی دیگه" button that
 * re-rolls. Built on the app's own radix Dialog so it matches every other
 * dialog (same airy inset, same close affordance, same footer bar).
 */
export function MotivationButton() {
  const [open, setOpen] = useState(false);
  // Index into the quotes array; initialised lazily on first open so the
  // very first quote is also random rather than a fixed entry.
  const [index, setIndex] = useState<number | null>(null);

  const show = (previous: number | null) => setIndex(pickQuote(previous));

  const current = index === null ? pickQuote(null) : index;
  const quote = quotes[current];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        // Roll a quote the moment the dialog opens.
        if (o) show(index);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="text-muted-foreground"
        >
          <Sparkles />
          {copy.timer.motivation}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-yellow-500" />
            {copy.timer.motivation}
          </DialogTitle>
        </DialogHeader>

        {/* The quote itself. Clamped so a long line cannot outgrow the box;
            the page's own font stack and RTL direction apply automatically.
            The speaker sits directly beneath the line, not in the footer. */}
        <blockquote className="my-2">
          <p
            dir="rtl"
            className="border-s-2 border-yellow-500/50 ps-4 text-lg leading-relaxed sm:text-xl"
          >
            {quote.text}
          </p>
          <cite className="mt-3 block ps-4 text-sm not-italic text-muted-foreground">
            — {quote.author}
            {quote.source ? ` (${quote.source})` : ""}
          </cite>
        </blockquote>

        <div className="mt-2 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            className="w-auto px-6"
            onClick={() => show(current)}
          >
            {copy.timer.motivationAnother}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
