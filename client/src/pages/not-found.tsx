import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Home } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-4">
        <h2 className="text-xl font-semibold">Page not found</h2>
        <p className="text-sm text-muted-foreground">The page you're looking for doesn't exist.</p>
        <Link href="/">
          <Button size="sm" data-testid="button-go-home">
            <Home className="w-3.5 h-3.5 mr-1.5" />
            Go to Dashboard
          </Button>
        </Link>
      </div>
    </div>
  );
}
