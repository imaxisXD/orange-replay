import { type ReactNode } from "react";
import { Toast } from "@base-ui/react/toast";
import { AlertCircle, Check, Info, Loader, X, type IconComponent } from "../../lib/icon-map";
import styles from "./orange-toast.module.css";

const orangeToastVariants = ["default", "success", "error", "warning", "info", "loading"] as const;

export type OrangeToastVariant = (typeof orangeToastVariants)[number];

const variantIcons: Record<OrangeToastVariant, IconComponent | null> = {
  default: null,
  success: Check,
  error: X,
  warning: AlertCircle,
  info: Info,
  loading: Loader,
};

const celebrationAssets: Record<OrangeToastVariant, string> = {
  default: "/visuals/orange-replay-toast-particles-default.png",
  success: "/visuals/orange-replay-toast-particles-success.png",
  error: "/visuals/orange-replay-toast-particles-error.png",
  warning: "/visuals/orange-replay-toast-particles-warning.png",
  info: "/visuals/orange-replay-toast-particles-info.png",
  loading: "/visuals/orange-replay-toast-particles-loading.png",
};

const originalPixelParticleAsset = "/visuals/orange-replay-toast-logo-particles-b.png";

export function OrangeToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider>
      {children}
      <Toast.Portal>
        <Toast.Viewport className={styles.viewport}>
          <OrangeToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

export function useOrangeToast() {
  return Toast.useToastManager();
}

function OrangeToastList() {
  const { toasts } = Toast.useToastManager();

  return toasts.map((toast, index) => {
    const variant = resolveToastVariant(toast.type);
    const celebrationAsset = celebrationAssets[variant];
    const hasAction = Boolean(toast.actionProps?.children);
    const isFront = index === 0;

    return (
      <Toast.Root
        className={styles.toastRoot}
        data-front={isFront ? "true" : undefined}
        data-has-action={hasAction ? "true" : undefined}
        data-testid="orange-toast"
        data-variant={variant}
        key={toast.id}
        swipeDirection={["down", "right"]}
        toast={toast}
      >
        <div className={styles.toastExit}>
          <div className={styles.toastStage}>
            {isFront && (
              <span aria-hidden className={styles.decorations}>
                <ToastParticle asset={originalPixelParticleAsset} className={styles.particleLeft} />
                <ToastParticle
                  asset={originalPixelParticleAsset}
                  className={styles.particleCenter}
                />
                <ToastParticle asset={celebrationAsset} className={styles.particleRight} />
                <ToastParticle asset={celebrationAsset} className={styles.particleBottom} />
              </span>
            )}

            <span aria-hidden className={styles.toastBackground} />

            <Toast.Content className={styles.toastContent}>
              <ToastSignal variant={variant} />
              <Toast.Title className={styles.toastMessage} />
              <Toast.Action className={styles.toastAction} />
              {!hasAction && (
                <Toast.Close aria-label="Dismiss notification" className={styles.toastClose}>
                  <X aria-hidden size={14} strokeWidth={1.75} />
                </Toast.Close>
              )}
            </Toast.Content>
          </div>
        </div>
      </Toast.Root>
    );
  });
}

function resolveToastVariant(type: string | undefined): OrangeToastVariant {
  return orangeToastVariants.includes(type as OrangeToastVariant)
    ? (type as OrangeToastVariant)
    : "default";
}

function ToastSignal({ variant }: { variant: OrangeToastVariant }) {
  const VariantIcon = variantIcons[variant];

  return (
    <span aria-hidden className={styles.toastSignal} data-toast-signal>
      {VariantIcon ? (
        <VariantIcon size={14} strokeWidth={variant === "loading" ? 1.5 : 2} />
      ) : (
        <span className={styles.toastBrandMark}>
          <span />
          <span />
          <span />
        </span>
      )}
    </span>
  );
}

function ToastParticle({ asset, className }: { asset: string; className?: string }) {
  const particleClassName = [styles.particle, className]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  return (
    <span className={particleClassName} data-toast-particle data-toast-particle-asset={asset}>
      <span className={styles.particleDrift}>
        <span className={styles.particleVisual} style={{ backgroundImage: `url(${asset})` }} />
      </span>
    </span>
  );
}
