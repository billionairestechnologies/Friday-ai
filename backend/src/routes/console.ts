import { Router } from "express";
import * as c from "../controllers/consoleController.js";
import * as p from "../controllers/plansController.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { requirePermission as can, requireStaff } from "../services/console/permissions.js";

/** Team Console API — staff only; every route names the permission it needs (see permissions.ts). */
export const consoleRouter = Router();
consoleRouter.use(requireAuth, requireStaff);
consoleRouter.use(rateLimit({ name: "team-console", limit: 1200, windowMs: 15 * 60_000 }));

const h = asyncHandler;

consoleRouter.get("/me", h(c.me));
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

consoleRouter.get("/mail", can("mail.manage"), h(c.listMail));
consoleRouter.post("/mail", can("mail.manage"), h(c.saveMail));
consoleRouter.delete("/mail/:identityId", can("mail.manage"), h(c.deleteMail));

consoleRouter.get("/updates", can("updates.view"), h(c.listUpdates));
consoleRouter.post("/updates", can("updates.manage"), h(c.createUpdate));
consoleRouter.patch("/updates/:updateId", can("updates.manage"), h(c.editUpdate));
consoleRouter.post("/updates/:updateId/status", can("updates.manage"), h(c.setUpdateStatus));
consoleRouter.delete("/updates/:updateId", can("updates.manage"), h(c.deleteUpdate));
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

consoleRouter.get("/plans", can("plans.view"), h(p.overview));
consoleRouter.post("/plans/packages", can("plans.manage"), h(p.savePackage));
consoleRouter.delete("/plans/packages/:packageId", can("plans.manage"), h(p.deletePackage));
consoleRouter.post("/plans/offers", can("plans.manage"), h(p.saveOffer));
consoleRouter.delete("/plans/offers/:offerId", can("plans.manage"), h(p.deleteOffer));
consoleRouter.post("/plans/grants", can("plans.manage"), h(p.grant));
consoleRouter.post("/plans/grants/:grantId/revoke", can("plans.manage"), h(p.revoke));
consoleRouter.post("/plans/redemptions/:redemptionId/review", can("plans.review"), h(p.review));

consoleRouter.get("/audit", can("audit.view"), h(c.auditLog));
