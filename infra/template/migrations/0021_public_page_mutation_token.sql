ALTER TABLE project_public_pages ADD COLUMN mutation_token TEXT;

CREATE UNIQUE INDEX idx_project_public_pages_mutation_token
ON project_public_pages(mutation_token);
