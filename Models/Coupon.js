const mongoose = require("mongoose");

const couponUserUsageSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, trim: true, lowercase: true },
    count: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
    },

    discountType: {
      type: String,
      enum: ["percentage", "flat"],
      default: "percentage",
    },

    discountValue: {
      type: Number,
      required: true,
    },

    minimumOrder: {
      type: Number,
      default: 0,
    },

    maximumDiscount: {
      type: Number,
      default: 0,
    },

    expiryDate: Date,

    active: {
      type: Boolean,
      default: true,
    },

    usageCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Per-customer limit: how many times ONE customer (matched by the email
    // on their order) may use this code. null = unlimited. The global
    // usageCount below stays as a total-used counter for reporting only.
    maxUses: {
      type: Number,
      min: 1,
      default: null,
    },

    perUserUsage: [couponUserUsageSchema],

    // Referral wallet linkage: when set, every successful order that uses
    // this coupon adds `referralBonus` to this user's wallet balance and
    // emails them that their code was used. The buyer still gets the normal
    // discount above — this is on top of that, not instead of it.
    assignedUserEmail: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },
    referralBonus: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Coupon", couponSchema);