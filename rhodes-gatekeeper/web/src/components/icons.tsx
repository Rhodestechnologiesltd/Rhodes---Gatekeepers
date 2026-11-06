import type { SVGProps } from 'react';

const base = (p: SVGProps<SVGSVGElement>) => ({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, ...p });

export const IconMeeting = (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17.5" cy="9" r="2.5" /><path d="M16 14.2c2.9.2 5 2.6 5 5.8" /></svg>);
export const IconTruck = (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><path d="M2 6h11v10H2z" /><path d="M13 9h4.5L21 12.5V16h-8" /><circle cx="6.5" cy="17.5" r="1.8" /><circle cx="17" cy="17.5" r="1.8" /></svg>);
export const IconCart = (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><path d="M3 4h2l2.4 11h10.8L21 7H6.2" /><circle cx="9" cy="19.5" r="1.5" /><circle cx="17" cy="19.5" r="1.5" /></svg>);
export const IconDots = (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /><rect x="2" y="5" width="20" height="14" rx="3" /></svg>);
export const IconIn = (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" /><path d="M10 17l5-5-5-5" /><path d="M15 12H3" /></svg>);
export const IconOut = (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></svg>);
export const IconCheck = (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)} strokeWidth={2.6}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>);
export const IconCamera = (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" /><circle cx="12" cy="13" r="4" /></svg>);
export const IconId = (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><rect x="2.5" y="5" width="19" height="14" rx="2" /><circle cx="8.5" cy="11" r="2.2" /><path d="M5.5 16c.5-1.6 1.6-2.4 3-2.4s2.5.8 3 2.4" /><path d="M14 10h4.5M14 13.5h3.5" /></svg>);

export const VISIT_TYPE_ICON = { meeting: IconMeeting, delivery: IconTruck, customer: IconCart, other: IconDots };
export const IconFolder = (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" /></svg>);
export const IconLock = (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>);
export const IconFile = (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></svg>);
export const IconImage = (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-9 9" /></svg>);
export const IconSearch = (p: SVGProps<SVGSVGElement>) => (<svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>);
