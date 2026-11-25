import React from "react";
import { Link } from "react-router-dom";
import type { Platform } from "../core/types.ts";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { useFormattedTime } from "@/lib/formatTime";
import { cn } from "@/lib/utils";

const Message = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { isUser?: boolean }
>(({ className, isUser, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex w-full items-end gap-2 py-1",
      isUser ? "justify-end" : "flex-row-reverse justify-end",
      className
    )}
    {...props}
  >
    {children}
  </div>
));
Message.displayName = "Message";

const MessageContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex flex-col gap-2 overflow-hidden rounded-lg border bg-card px-3 py-2 text-base leading-relaxed text-card-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
));
MessageContent.displayName = "MessageContent";

function renderMessageText(text: any): React.ReactNode {
  if (typeof text === 'string') {
      return <span className="whitespace-pre-wrap">{text}</span>;
  }
  
  if (Array.isArray(text)) {
    return (
        <div className="flex flex-col gap-1">
            {text.map((part, i) => {
                if (typeof part === 'string') return <span key={i} className="whitespace-pre-wrap">{part}</span>;
                if (typeof part === 'object' && part !== null) {
                    if (part.text) {
                        if (part.type === 'bold') return <strong key={i}>{part.text}</strong>;
                        if (part.type === 'italic') return <em key={i}>{part.text}</em>;
                        if (part.type === 'code') return <code key={i} className="bg-muted px-1 rounded">{part.text}</code>;
                        if (part.type === 'pre') return <pre key={i} className="bg-muted p-1 rounded my-1 overflow-x-auto whitespace-pre-wrap">{part.text}</pre>;
                        if (part.type === 'link') return <a key={i} href={part.href || '#'} className="text-primary underline hover:no-underline">{part.text}</a>;
                        return <span key={i}>{part.text}</span>;
                    }
                }
                return null;
            })}
        </div>
    );
  }
  
  if (typeof text === 'object' && text !== null && text.text) {
      return <span className="whitespace-pre-wrap">{text.text}</span>;
  }
  
  return null;
}

// Ensure type handles children appropriately
const DefaultMessageComponent: Platform["MessageComponent"] = ({ message, children }) => {
  const formattedDate = useFormattedTime(new Date(message.timestamp));
  const senderName = message.raw?.from || message.raw?.sender_name || "Unknown";

  const hasText = message.text && (
      typeof message.text === 'string' 
      ? message.text.length > 0 
      : (Array.isArray(message.text as any) && (message.text as any).length > 0) || (typeof message.text === 'object' && message.text !== null)
  );


  return (
    <Message isUser={false}>
        <div className="flex flex-col gap-1 max-w-[95%] min-w-0 sm:max-w-[min(85%,72ch)]">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1">
                {message.senderId ? (
                  <Link className="break-words text-sm font-semibold text-primary hover:underline" to={`/objects/${message.senderId.toString()}`}>
                    {senderName}
                  </Link>
                ) : <span className="break-words text-sm font-semibold">{senderName}</span>}
                <span className="text-xs text-muted-foreground">{formattedDate}</span>
            </div>
            
            <MessageContent className="break-words overflow-hidden">
                <div className="overflow-x-auto max-w-full">
                    {children}
                    {hasText ? (
                        renderMessageText(message.text)
                    ) : (
                        (!children && (!message.media || message.media.length === 0)) && (
                            <CodeBlock
                                code={JSON.stringify(message.raw, null, 2)}
                                language="json"
                                className="text-xs"
                            />
                        )
                    )}
                </div>
                
                {message.media && message.media.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                        {message.media.map((media, idx) => (
                            <div key={idx} className="p-2 bg-muted/50 overflow-hidden max-w-full">
                                {media.type === "image" && media.url ? (
                                    <img src={media.url} alt="media" className="max-w-xs rounded-md h-auto" />
                                ) : (
                                    <div className="flex items-center gap-2 overflow-hidden">
                                        <span className="text-xs uppercase font-bold shrink-0">{media.type}</span>
                                        <span className="text-xs truncate max-w-[150px]">{media.fileName || "File"}</span>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </MessageContent>
        </div>
    </Message>
  );
};

export const defaultPlatform: Platform = {
  id: "default",
  name: "Default",
  MessageComponent: DefaultMessageComponent,
};
