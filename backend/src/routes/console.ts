import { Router } from "express";
import * as c from "../controllers/consoleController.js";
import * as p from "../controllers/plansController.js";
import * as st from "../controllers/statusController.js";
import * as fin from "../controllers/financeController.js";
import * as ul from "../controllers/usageLedgerController.js";
import * as mail from "../controllers/mailController.js";
import * as mult from "../controllers/multiplierController.js";
import * as credits from "../controllers/creditsController.js";
import * as prog from "../controllers/programController.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { requireAnyPermission, requirePermission as can, requireStaff } from "../services/console/permissions.js";

/** Team Console API — staff only; every route names the permission it needs (see permissions.ts). */
export const consoleRouter = Router();
consoleRouter.use(requireAuth, requireStaff);
consoleRouter.use(rateLimit({ name: "team-console", limit: 1200, windowMs: 15 * 60_000 }));

const h = asyncHandler;

consoleRouter.get("/me", h(c.me));
consoleRouter.get("/staff", h(c.staffDirectory));
consoleRouter.get("/overview", can("overview.view"), h(c.overview));

consoleRouter.get("/users", can("users.view"), h(c.listUsers));
consoleRouter.get("/users/:userId", can("users.view"), h(c.getUser));
consoleRouter.patch("/users/:userId", can("users.manage"), h(c.updateUser));

consoleRouter.get("/team", can("team.manage"), h(c.listTeam));
consoleRouter.post("/team", can("team.manage"), h(c.inviteMember));
consoleRouter.patch("/team/:userId", can("team.manage"), h(c.updateMember));
consoleRouter.delete("/team/:userId", can("team.manage"), h(c.removeMember));
consoleRouter.post("/roles", can("team.manage"), h(c.saveRole));
consoleRouter.delete("/roles/:roleId", can("team.manage"), h(c.deleteRole));

consoleRouter.get("/mail", requireAnyPermission("mail.manage", "marketing.view", "support.view"), h(c.listMail));
consoleRouter.post("/mail", can("mail.manage"), h(c.saveMail));
consoleRouter.delete("/mail/:identityId", can("mail.manage"), h(c.deleteMail));

consoleRouter.get("/updates", can("updates.view"), h(c.listUpdates));
consoleRouter.post("/updates", can("updates.manage"), h(c.createUpdate));
consoleRouter.patch("/updates/:updateId", can("updates.manage"), h(c.editUpdate));
consoleRouter.post("/updates/:updateId/status", can("updates.manage"), h(c.setUpdateStatus));
consoleRouter.delete("/updates/:updateId", can("updates.manage"), h(c.deleteUpdate));
consoleRouter.post("/updates/:updateId/new-version", can("updates.manage"), h(c.republishUpdate));
consoleRouter.post("/updates/:updateId/campaign", can("marketing.manage"), h(c.campaignFromUpdate));

consoleRouter.get("/campaigns", can("marketing.view"), h(c.listCampaigns));
consoleRouter.get("/campaigns/audience", can("marketing.view"), h(c.audienceCount));
consoleRouter.post("/campaigns", can("marketing.manage"), h(c.createCampaign));
consoleRouter.patch("/campaigns/:campaignId", can("marketing.manage"), h(c.editCampaign));
consoleRouter.delete("/campaigns/:campaignId", can("marketing.manage"), h(c.deleteCampaign));
consoleRouter.post("/campaigns/:campaignId/test", can("marketing.manage"), h(c.testCampaign));
consoleRouter.post("/campaigns/:campaignId/send", can("marketing.send"), h(c.sendCampaign));
consoleRouter.post("/campaigns/:campaignId/cancel", can("marketing.send"), h(c.cancelCampaign));

consoleRouter.get("/crm", can("crm.view"), h(c.crmBoard));
consoleRouter.post("/crm/contacts", can("crm.manage"), h(c.createContact));
consoleRouter.get("/crm/contacts/:contactId", can("crm.view"), h(c.getContact));
consoleRouter.patch("/crm/contacts/:contactId", can("crm.manage"), h(c.updateContact));
consoleRouter.delete("/crm/contacts/:contactId", can("crm.manage"), h(c.deleteContact));
consoleRouter.post("/crm/contacts/:contactId/activities", can("crm.manage"), h(c.addContactActivity));
consoleRouter.post("/crm/stages", can("crm.manage"), h(c.saveStage));
consoleRouter.delete("/crm/stages/:stageId", can("crm.manage"), h(c.deleteStage));

consoleRouter.get("/support", can("support.view"), h(c.listTickets));
consoleRouter.post("/support", can("support.reply"), h(c.createTicketForUser));
consoleRouter.get("/support/:ticketId", can("support.view"), h(c.getTicket));
consoleRouter.post("/support/:ticketId/reply", can("support.reply"), h(c.replyTicket));
consoleRouter.patch("/support/:ticketId", can("support.manage"), h(c.updateTicket));

consoleRouter.get("/tasks", can("tasks.view"), h(c.listTasks));
consoleRouter.post("/tasks", can("tasks.manage"), h(c.createTask));
consoleRouter.patch("/tasks/:taskId", can("tasks.manage"), h(c.updateTask));
consoleRouter.delete("/tasks/:taskId", can("tasks.manage"), h(c.deleteTask));

consoleRouter.get("/status", can("status.view"), h(st.consoleOverview));
consoleRouter.post("/status/incidents", can("status.manage"), h(st.createIncident));
consoleRouter.post("/status/incidents/:incidentId/updates", can("status.manage"), h(st.updateIncident));
consoleRouter.delete("/status/incidents/:incidentId", can("status.manage"), h(st.deleteIncident));
consoleRouter.post("/status/checks", can("status.manage"), h(st.runChecks));
consoleRouter.post("/status/provider-issues/:issueId/resolve", can("status.manage"), h(st.resolveProviderIssueRoute));
consoleRouter.get("/status/crashes/:crashId", can("status.view"), h(st.crashDetail));
consoleRouter.get("/plans", can("plans.view"), h(p.overview));
consoleRouter.post("/plans/packages", can("plans.manage"), h(p.savePackage));
consoleRouter.patch("/plans/catalog/:planId", can("plans.manage"), h(p.saveCatalog));
consoleRouter.get("/plans/economics", can("plans.view"), h(p.economics));
consoleRouter.get("/plans/entitlements", can("plans.view"), h(p.userEntitlements));
consoleRouter.delete("/plans/packages/:packageId", can("plans.manage"), h(p.deletePackage));
consoleRouter.post("/plans/offers", can("plans.manage"), h(p.saveOffer));
consoleRouter.delete("/plans/offers/:offerId", can("plans.manage"), h(p.deleteOffer));
consoleRouter.post("/plans/grants", can("plans.manage"), h(p.grant));
consoleRouter.post("/plans/grants/:grantId/revoke", can("plans.manage"), h(p.revoke));
consoleRouter.post("/plans/redemptions/:redemptionId/review", can("plans.review"), h(p.review));

// Student / startup / company programmes (supabase 0061).
consoleRouter.get("/programs", can("plans.view"), h(prog.consoleOverview));
consoleRouter.post("/programs/applications/:applicationId/decide", can("plans.review"), h(prog.decide));
consoleRouter.post("/programs/applications/:applicationId/retry", can("plans.review"), h(prog.retry));
consoleRouter.get("/programs/applications/:applicationId/evidence/:fileId", can("plans.review"), h(prog.evidence));
consoleRouter.post("/programs/settings/:program", can("plans.manage"), h(prog.saveSettings));

consoleRouter.get("/audit", can("audit.view"), h(c.auditLog));

// Finance: model prices (cost vs sell), the P&L report and expenses.
// Usage ledger: balances, holds, adjustments, reconciliation (supabase 0057).
consoleRouter.get("/usage/overview", can("users.view"), h(ul.overview));
consoleRouter.get("/usage/accounts", can("users.view"), h(ul.accounts));
consoleRouter.get("/usage/accounts/:accountId", can("users.view"), h(ul.account));
consoleRouter.post("/usage/accounts/:accountId/adjust", can("users.manage"), h(ul.adjust));
consoleRouter.post("/usage/accounts/:accountId/status", can("users.manage"), h(ul.setStatus));
consoleRouter.get("/usage/calls", can("users.view"), h(ul.calls));
consoleRouter.get("/usage/export.csv", can("users.view"), h(ul.exportCsv));
consoleRouter.post("/usage/reconcile", can("users.manage"), h(ul.reconcile));
// Credit grants: bonus tokens on top of the monthly allowance, with expiry and approval (supabase 0060).
consoleRouter.get("/credits", can("credits.view"), h(credits.overview));
consoleRouter.get("/credits/grants", can("credits.view"), h(credits.list));
consoleRouter.post("/credits/grants", can("credits.grant"), h(credits.grant));
consoleRouter.post("/credits/bulk/preview", can("credits.grant"), h(credits.preview));
consoleRouter.post("/credits/bulk", can("credits.grant"), h(credits.bulk));
consoleRouter.post("/credits/grants/:grantId/approve", can("credits.approve"), h(credits.approve));
consoleRouter.post("/credits/grants/:grantId/revoke", can("credits.grant"), h(credits.revoke));
consoleRouter.post("/credits/batches/:batchId/approve", can("credits.approve"), h(credits.approveBatchRoute));
consoleRouter.post("/credits/batches/:batchId/reject", can("credits.approve"), h(credits.rejectBatchRoute));
consoleRouter.post("/credits/settings", can("credits.settings"), h(credits.settings));

// Model usage multipliers: how much of the allowance each model's tokens cost (supabase 0059).
consoleRouter.get("/models/multipliers", can("providers.view"), h(mult.overview));
consoleRouter.post("/models/multipliers", can("models.multipliers"), h(mult.publish));
consoleRouter.post("/models/multipliers/:multiplierId/cancel", can("models.multipliers"), h(mult.cancel));
consoleRouter.get("/finance/live", can("finance.view"), h(fin.live));
consoleRouter.get("/finance/summary", can("finance.view"), h(fin.summary));
consoleRouter.get("/finance/report", can("finance.view"), h(fin.report));
consoleRouter.get("/finance/pricing", can("finance.view"), h(fin.pricing));
consoleRouter.post("/finance/pricing", can("finance.manage"), h(fin.savePrice));
consoleRouter.delete("/finance/pricing/:priceId", can("finance.manage"), h(fin.removePrice));
consoleRouter.post("/finance/pricing/sync", can("finance.manage"), h(fin.syncPrices));
consoleRouter.post("/finance/settings", can("finance.manage"), h(fin.settings));
consoleRouter.get("/finance/expenses", can("finance.view"), h(fin.expenses));
consoleRouter.post("/finance/expenses", can("finance.manage"), h(fin.addExpense));
consoleRouter.patch("/finance/expenses/:expenseId", can("finance.manage"), h(fin.editExpense));
consoleRouter.delete("/finance/expenses/:expenseId", can("finance.manage"), h(fin.removeExpense));

// Company mail hosting (admin): domains + employee mailboxes on our mail server.
consoleRouter.get("/mail-hosting", can("mail.manage"), h(mail.hostingOverview));
consoleRouter.post("/mail-hosting/domains", can("mail.manage"), h(mail.addDomain));
consoleRouter.get("/mail-hosting/domains/:domain/dns", can("mail.manage"), h(mail.domainDns));
consoleRouter.post("/mail-hosting/mailboxes", can("mail.manage"), h(mail.createMailbox));
consoleRouter.patch("/mail-hosting/mailboxes/:mailboxId", can("mail.manage"), h(mail.updateMailbox));
consoleRouter.delete("/mail-hosting/mailboxes/:mailboxId", can("mail.manage"), h(mail.deleteMailbox));

// Webmail: each staff member's own accounts only (hosted mailbox + Gmail/Outlook/any IMAP).
consoleRouter.get("/mailbox/accounts", can("mailbox.use"), h(mail.accounts));
consoleRouter.post("/mailbox/accounts", can("mailbox.use"), h(mail.addAccount));
consoleRouter.delete("/mailbox/accounts/:accountId", can("mailbox.use"), h(mail.removeAccount));
consoleRouter.post("/mailbox/accounts/:accountId/default", can("mailbox.use"), h(mail.makeDefault));
consoleRouter.post("/mailbox/accounts/:accountId/password", can("mailbox.use"), h(mail.changePassword));
consoleRouter.get("/mailbox/accounts/:accountId/folders", can("mailbox.use"), h(mail.folders));
consoleRouter.get("/mailbox/accounts/:accountId/messages", can("mailbox.use"), h(mail.messages));
consoleRouter.get("/mailbox/accounts/:accountId/messages/:uid", can("mailbox.use"), h(mail.message));
consoleRouter.get("/mailbox/accounts/:accountId/messages/:uid/attachments/:index", can("mailbox.use"), h(mail.attachment));
consoleRouter.post("/mailbox/accounts/:accountId/actions", can("mailbox.use"), h(mail.act));
consoleRouter.post("/mailbox/accounts/:accountId/send", can("mailbox.use"), h(mail.send));
