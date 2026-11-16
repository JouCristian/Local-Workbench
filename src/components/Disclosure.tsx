import { useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import { appleEase, useMotionPreference } from './motion';
export function Disclosure({ title, children }: { title: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true),
    reduced = useMotionPreference();
  return (
    <section className="tree-stage" data-open={open}>
      <button
        type="button"
        className="stage-summary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight size={15} className="chevron" />
        {title}
      </button>
      <motion.div
        className="stage-collapse"
        initial={false}
        animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
        transition={{ duration: reduced ? 0 : 0.28, ease: appleEase }}
        inert={!open}
        aria-hidden={!open}
        style={{ overflow: 'hidden' }}
      >
        <div className="tree-content">{children}</div>
      </motion.div>
    </section>
  );
}
