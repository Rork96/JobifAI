# backend/services/ — Stateless business-logic helpers
#
# Each module in this package encapsulates one external concern:
#   parser.py  — extract text from uploaded resume files (PDF, DOCX, TXT)
#   scraper.py — fetch and clean job description text from a URL
#
# Routers import these helpers rather than embedding the logic inline.
# This separation means:
#   • The same parser can be called from the upload router AND any future
#     Supabase storage trigger without duplicating code.
#   • Services are easy to unit-test in isolation (no HTTP concerns).
