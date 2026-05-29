'use client'

import { useEffect, useMemo, useState } from 'react'

interface OperitPreviewImageProps {
  alt: string
  deviceId?: number | null
  tick?: number
  display?: 'main' | 'virtual'
  format?: 'jpg' | 'png'
  quality?: number
  scale?: number
  wrapperClassName?: string
  imageClassName?: string
  fallbackText?: string
}

export function OperitPreviewImage({
  alt,
  deviceId,
  tick = 0,
  display = 'main',
  format = 'jpg',
  quality = 48,
  scale = 28,
  wrapperClassName = '',
  imageClassName = '',
  fallbackText = 'Preview unavailable',
}: OperitPreviewImageProps) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [deviceId, tick, display, format, quality, scale])

  const src = useMemo(() => {
    if (!deviceId) return null
    const params = new URLSearchParams({
      display,
      format,
      quality: String(quality),
      scale: String(scale),
      ts: String(tick),
    })
    return `/api/integrations/operit/devices/${deviceId}/preview?${params.toString()}`
  }, [deviceId, display, format, quality, scale, tick])

  return (
    <div className={wrapperClassName}>
      {!src || failed ? (
        <div className="flex h-full w-full items-center justify-center bg-slate-950/70 text-center text-[11px] text-muted-foreground/70">
          {fallbackText}
        </div>
      ) : (
        <>
          {/* Rapid no-cache preview refreshes are more reliable here without Next/Image optimization. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            className={imageClassName}
            loading="lazy"
            onError={() => setFailed(true)}
          />
        </>
      )}
    </div>
  )
}
