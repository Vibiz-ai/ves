"""Optional: write OpenAI Agents SDK spans as JSONL for the VES `trace` connector (format "openai-agents").

    from agents import add_trace_processor
    add_trace_processor(VesTraceProcessor("traces/run.jsonl"))

Each finished span is written as span.export() (span_data.type function | generation | agent | response). Traced
evidence can fail a VES safety check but never pass one. Written offline against the openai-agents docs (unverified).
"""
import json, threading
from agents.tracing import TracingProcessor


class VesTraceProcessor(TracingProcessor):
    def __init__(self, path):
        self.f = open(path, "a", encoding="utf-8")
        self.lock = threading.Lock()

    def _write(self, obj):
        if obj:
            with self.lock:
                self.f.write(json.dumps(obj, default=str) + "\n")
                self.f.flush()

    def on_trace_start(self, trace): pass
    def on_trace_end(self, trace): pass
    def on_span_start(self, span): pass
    def on_span_end(self, span): self._write(span.export())
    def shutdown(self): self.f.close()
    def force_flush(self): self.f.flush()

    def final_output(self, text):
        """Call with the run's final_output so the grader sees the delivered message."""
        self._write({"object": "ves.message", "text": str(text)})
