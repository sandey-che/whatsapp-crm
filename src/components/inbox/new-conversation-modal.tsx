"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Contact } from "@/types";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface NewConversationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectContact: (contact: Contact) => void;
}

export function NewConversationModal({
  open,
  onOpenChange,
  onSelectContact,
}: NewConversationModalProps) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);

  useEffect(() => {
    if (!open) return;

    const fetchContacts = async () => {
      setLoading(true);
      const supabase = createClient();
      const { data, error } = await supabase
        .from("contacts")
        .select("*")
        .order("name", { ascending: true, nullsFirst: false });

      if (!error) {
        setContacts((data as Contact[]) ?? []);
      }
      setLoading(false);
    };

    fetchContacts();
  }, [open]);

  const filtered = search.trim()
    ? contacts.filter((c) => {
        const q = search.toLowerCase();
        const name = c.name?.toLowerCase() ?? "";
        const phone = c.phone?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q);
      })
    : contacts;

  const handleSelect = useCallback(
    (contact: Contact) => {
      onSelectContact(contact);
      onOpenChange(false);
      setSearch("");
      setSelectedContact(null);
    },
    [onSelectContact, onOpenChange]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm bg-slate-900 border-slate-700">
        <DialogHeader>
          <DialogTitle className="text-white">Start New Conversation</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contacts..."
              className="border-slate-700 bg-slate-800 pl-9 text-sm text-white placeholder-slate-500 focus:border-violet-500/50"
              autoFocus
            />
          </div>

          {/* Contact List */}
          <ScrollArea className="h-80 rounded-lg border border-slate-700">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-sm text-slate-500">
                  {search.trim() ? "No contacts found" : "No contacts yet"}
                </p>
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-slate-800">
                {filtered.map((contact) => {
                  const displayName = contact.name || contact.phone || "Unknown";
                  const initials = displayName.charAt(0).toUpperCase();

                  return (
                    <button
                      key={contact.id}
                      onClick={() => handleSelect(contact)}
                      className={cn(
                        "flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-800",
                        selectedContact?.id === contact.id && "bg-slate-800"
                      )}
                    >
                      {/* Avatar */}
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-700 text-sm font-medium text-white">
                        {contact.avatar_url ? (
                          <img
                            src={contact.avatar_url}
                            alt={displayName}
                            className="h-10 w-10 rounded-full object-cover"
                          />
                        ) : (
                          initials
                        )}
                      </div>

                      {/* Info */}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-white">
                          {displayName}
                        </p>
                        {contact.email && (
                          <p className="truncate text-xs text-slate-400">
                            {contact.email}
                          </p>
                        )}
                        {contact.company && (
                          <p className="truncate text-xs text-slate-500">
                            {contact.company}
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </ScrollArea>

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white"
            >
              Cancel
            </Button>
            <Button
              onClick={() => selectedContact && handleSelect(selectedContact)}
              disabled={!selectedContact}
              className="bg-violet-600 hover:bg-violet-700 text-white"
            >
              Start Conversation
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
