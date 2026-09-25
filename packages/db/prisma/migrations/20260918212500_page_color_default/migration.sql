-- The inbox tags each connected Page with a colour. The default moved from the
-- old indigo to LeadWave's brand teal when the palette changed.
--
-- Written by hand rather than generated: `prisma migrate dev` wants an
-- interactive confirmation for a default change, which does not work in a
-- non-interactive shell.
ALTER TABLE "ConnectedAccount" ALTER COLUMN "color" SET DEFAULT '#157A70';
