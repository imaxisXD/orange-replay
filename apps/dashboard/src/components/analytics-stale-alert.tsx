import { AlertCircle } from "../lib/icon-map";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";

export function AnalyticsStaleAlert() {
  return (
    <Alert className="border-amber/30 bg-amber/5 text-foreground [&>svg]:text-amber">
      <AlertCircle aria-hidden />
      <AlertTitle>Analytics may be out of date</AlertTitle>
      <AlertDescription>
        The analytics service is temporarily unavailable, so these are the last saved results. New
        sessions or changes may not appear yet.
      </AlertDescription>
    </Alert>
  );
}
