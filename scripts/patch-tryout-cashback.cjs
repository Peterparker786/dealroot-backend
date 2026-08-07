const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "src", "server.js");
let src = fs.readFileSync(file, "utf8");

let applied = [];

// 1. Extend the TryoutApplication schema with cashback fields.
const schemaAnchor = `    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "disqualified"],
      default: "pending",
      index: true,
    },
    requestedAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);`;

const schemaReplacement = `    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "disqualified"],
      default: "pending",
      index: true,
    },
    requestedAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
    cashbackAvailable: { type: Number, default: 0, min: 0 },
    cashbackPending: { type: Number, default: 0, min: 0 },
    cashbackReceived: { type: Number, default: 0, min: 0 },
    cashbackHistory: [
      {
        amount: { type: Number, required: true, min: 0 },
        note: { type: String, default: "" },
        status: {
          type: String,
          enum: ["available", "pending", "received"],
          default: "available",
        },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);`;

if (src.includes(schemaAnchor) && !src.includes("cashbackAvailable")) {
  src = src.replace(schemaAnchor, schemaReplacement);
  applied.push("schema cashback fields");
}

// 2. Add a cashback summary to the member's /api/tryouts/my response.
const myAnchor = `    res.json({
      success: true,
      application,
      approved: application?.status === "approved",
    });
  } catch {
    res.status(500).json({ success: false, message: "Could not load your application" });
  }
});`;

const myReplacement = `    const totalOrders = await Order.countDocuments({
      user: req.user.userId,
    });

    res.json({
      success: true,
      application,
      approved: application?.status === "approved",
      dashboard: application
        ? {
            totalOrders,
            cashbackAvailable: application.cashbackAvailable || 0,
            cashbackPending: application.cashbackPending || 0,
            cashbackReceived: application.cashbackReceived || 0,
            history: (application.cashbackHistory || []).slice().reverse(),
          }
        : null,
    });
  } catch {
    res.status(500).json({ success: false, message: "Could not load your application" });
  }
});`;

if (src.includes(myAnchor)) {
  src = src.replace(myAnchor, myReplacement);
  applied.push("member dashboard summary");
}

// 3. Add admin endpoints after the disqualify route (before startServer).
const adminAnchor = `    res.json({ success: true, message: "Member disqualified — Tryout deals are locked again", application });
  } catch {
    res.status(500).json({ success: false, message: "Could not disqualify member" });
  }
});

const startServer = async () => {`;

const adminReplacement = `    res.json({ success: true, message: "Member disqualified — Tryout deals are locked again", application });
  } catch {
    res.status(500).json({ success: false, message: "Could not disqualify member" });
  }
});

// Admin: add cashback for an approved Tryout member (available balance).
app.post("/api/tryouts/:id/cashback", requireAdmin, async (req, res) => {
  try {
    const application = await TryoutApplication.findById(req.params.id);
    if (!application) {
      return res.status(404).json({ success: false, message: "Application not found" });
    }
    if (application.status !== "approved") {
      return res.status(400).json({ success: false, message: "Only approved members can receive cashback" });
    }

    const amount = Math.max(0, Number(req.body?.amount) || 0);
    const note = String(req.body?.note || "").trim();

    if (amount <= 0) {
      return res.status(400).json({ success: false, message: "Please enter a valid cashback amount" });
    }

    application.cashbackHistory.push({ amount, note, status: "available" });
    application.cashbackAvailable = (application.cashbackAvailable || 0) + amount;
    await application.save();

    res.json({
      success: true,
      message: "Cashback added — member can now see it in their dashboard",
      application,
    });
  } catch (error) {
    console.error("Tryout cashback add failed:", error.message);
    res.status(500).json({ success: false, message: "Could not add cashback" });
  }
});

// Admin: move a cashback entry between available / pending / received.
app.patch("/api/tryouts/cashback/:entryId", requireAdmin, async (req, res) => {
  try {
    const nextStatus = String(req.body?.status || "");
    if (!["available", "pending", "received"].includes(nextStatus)) {
      return res.status(400).json({ success: false, message: "Invalid cashback status" });
    }

    const application = await TryoutApplication.findOne({
      "cashbackHistory._id": req.params.entryId,
    });
    if (!application) {
      return res.status(404).json({ success: false, message: "Cashback entry not found" });
    }

    const entry = application.cashbackHistory.id(req.params.entryId);
    if (!entry) {
      return res.status(404).json({ success: false, message: "Cashback entry not found" });
    }

    // Rebalance the totals from the current entry status to the new one.
    const from = entry.status;
    if (from !== nextStatus) {
      const delta = entry.amount || 0;
      const subtract = (key) => {
        application[key] = Math.max(0, (application[key] || 0) - delta);
      };
      const add = (key) => {
        application[key] = (application[key] || 0) + delta;
      };

      subtract("cashback" + from.charAt(0).toUpperCase() + from.slice(1));
      add("cashback" + nextStatus.charAt(0).toUpperCase() + nextStatus.slice(1));

      entry.status = nextStatus;
      await application.save();
    }

    res.json({
      success: true,
      message: "Cashback status updated",
      application,
    });
  } catch (error) {
    console.error("Tryout cashback update failed:", error.message);
    res.status(500).json({ success: false, message: "Could not update cashback" });
  }
});

const startServer = async () => {`;

if (src.includes(adminAnchor)) {
  src = src.replace(adminAnchor, adminReplacement);
  applied.push("admin cashback endpoints");
}

fs.writeFileSync(file, src, "utf8");
console.log("Applied:", applied.length ? applied.join(", ") : "NOTHING");
