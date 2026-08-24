import { useState, useEffect, useRef, useCallback } from 'react'
import api from './endpoints.js'

/* ------------------------------------------------------------------ */
/* Shared tiny UI atoms                                                */
/* ------------------------------------------------------------------ */
export function Pill({ ok, children, title }) {
  return (
    <span className={`pill ${ok ? 'pill--ok' : 'pill--off'}`} title={title}>{children}</span>
  )
}

export function Section({ title, right, children }) {
  return (
    <div className="card">
      <div className="card__head">
        <span>{title}</span>
        <span className="card__right">{right}</span>
      </div>
      <div className="card__body">{children}</div>
    </div>
  )
}

export function Btn({ kind = '', ...p }) {
  return <button type="button" className={`btn ${kind}`} {...p} />
}
