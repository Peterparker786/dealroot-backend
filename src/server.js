require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Razorpay = require("razorpay");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");

// Escapes user-provided text before it is placed inside HTML emails.
const xmlEscape = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const app = express();
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});
async function sendOTP(
  email,
  otp,
  subject = "Dealroot Password Reset OTP",
  heading = "Reset your password",
  intro = "Your Dealroot verification code is:"
) {
  await transporter.sendMail({
    from: `"Dealroot" <${process.env.EMAIL_USER}>`,
    to: email,
    subject,
    html: `
      <div style="font-family:Arial;padding:30px">
        <h2>${heading}</h2>

        <p>${intro}</p>

        <h1 style="
          letter-spacing:8px;
          color:#2563eb;
        ">
          ${otp}
        </h1>

        <p>This OTP will expire in 10 minutes.</p>

        <p>If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
}

// Send order confirmation emails: one to the customer (Amazon/Nykaa style)
// and one to the store owner so they know an order was placed.
async function sendOrderEmails(order) {
  if (!order) return;

  const customerEmail =
    String(order.customer?.email || "").trim() ||
    (order.user ? (await User.findOne({ _id: order.user }).select("email"))?.email : "") ||
    "";

  const ownerEmail = String(process.env.ADMIN_EMAIL || "").trim();
  const from = `"DEALROOT Beauty" <${process.env.EMAIL_USER}>`;

  const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;
  const paymentLabel =
    order.paymentMethod === "razorpay" ? "Paid online (Razorpay)" : "Cash on Delivery";

  const itemsHtml = (order.items || [])
    .map(
      (item) => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:13px;color:#333;">
            <strong>${item.title}</strong><br/>
            <span style="color:#999;font-size:12px;">${item.brand || ""} &bull; Qty: ${item.quantity}</span>
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:13px;color:#333;text-align:right;white-space:nowrap;">${money(item.subtotal)}</td>
        </tr>`
    )
    .join("");

  const trackUrl = seoSiteUrl + "/account";

  const summaryHtml = `
    <tr><td style="padding:6px 12px;font-size:13px;color:#666;">Item total</td><td style="padding:6px 12px;font-size:13px;color:#333;text-align:right;">${money((order.totalAmount || 0) - (order.deliveryFee || 0) + (order.discountAmount || 0))}</td></tr>
    ${order.discountAmount
      ? `<tr><td style="padding:6px 12px;font-size:13px;color:#059669;">Coupon (${order.couponCode || ""})</td><td style="padding:6px 12px;font-size:13px;color:#059669;text-align:right;">-${money(order.discountAmount)}</td></tr>`
      : ""}
    <tr><td style="padding:6px 12px;font-size:13px;color:#666;">Delivery fee</td><td style="padding:6px 12px;font-size:13px;color:#333;text-align:right;">${order.deliveryFee ? money(order.deliveryFee) : "FREE"}</td></tr>
    <tr><td style="padding:10px 12px;font-size:15px;font-weight:700;color:#111;">Order total</td><td style="padding:10px 12px;font-size:15px;font-weight:700;color:#111;text-align:right;">${money(order.totalAmount)}</td></tr>
  `;

  const address = order.customer || {};

  const customerSubject = `Thank you for your order ${order.orderNumber}`;
  const customerHtml = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#fff;">
      <div style="background:#e21c48;padding:24px 28px;text-align:center;">
        <h1 style="color:#fff;margin:0;font-size:22px;">DEALROOT BEAUTY</h1>
        <p style="color:#ffe4e9;margin:6px 0 0;font-size:13px;">Thank you for placing your order!</p>
      </div>
      <div style="padding:28px;">
        <p style="font-size:14px;color:#333;">Hi ${address.name || "there"},</p>
        <p style="font-size:14px;color:#555;line-height:1.6;">
          Your order has been received and is being processed. Here are your order details:
        </p>
        <div style="background:#fff5f7;border:1px solid #ffd6de;border-radius:10px;padding:14px 18px;margin:18px 0;">
          <span style="font-size:12px;color:#999;display:block;">ORDER ID</span>
          <strong style="font-size:18px;color:#e21c48;">${order.orderNumber}</strong>
          <span style="font-size:12px;color:#999;display:block;margin-top:8px;">PAYMENT</span>
          <span style="font-size:14px;color:#333;">${paymentLabel}</span>
        </div>
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr><th style="text-align:left;padding:8px 12px;background:#fafafa;font-size:12px;color:#999;text-transform:uppercase;">Item</th><th style="text-align:right;padding:8px 12px;background:#fafafa;font-size:12px;color:#999;text-transform:uppercase;">Amount</th></tr></thead>
          <tbody>${itemsHtml}${summaryHtml}</tbody>
        </table>
        <div style="background:#fafafa;border-radius:10px;padding:14px 18px;margin:20px 0;">
          <strong style="font-size:12px;color:#999;display:block;margin-bottom:6px;">DELIVER TO</strong>
          <p style="margin:0;font-size:13px;color:#333;line-height:1.6;">
            ${address.name}<br/>${address.address || ""}<br/>${address.city || ""}, ${address.state || ""} ${address.pincode || ""}<br/>Phone: ${address.phone || ""}
          </p>
        </div>
        <a href="${trackUrl}" style="display:block;text-align:center;background:#e21c48;color:#fff;text-decoration:none;padding:14px;border-radius:999px;font-size:14px;font-weight:700;">Track Your Order</a>
        <p style="font-size:12px;color:#999;margin-top:20px;line-height:1.6;text-align:center;">
          Questions? Reach us at dealroot.store@gmail.com or @Tom_andrew72 on Telegram.
        </p>
      </div>
    </div>
  `;

  const ownerSubject = `🛒 New order placed: ${order.orderNumber}`;
  const ownerHtml = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#fff;">
      <div style="background:#111;padding:22px 28px;text-align:center;">
        <h1 style="color:#fff;margin:0;font-size:20px;">🛒 New Order Placed</h1>
        <p style="color:#aaa;margin:6px 0 0;font-size:13px;">A customer just placed an order on DEALROOT</p>
      </div>
      <div style="padding:28px;">
        <div style="background:#fff5f7;border:1px solid #ffd6de;border-radius:10px;padding:14px 18px;margin-bottom:18px;">
          <strong style="font-size:16px;color:#e21c48;">${order.orderNumber}</strong><br/>
          <span style="font-size:12px;color:#666;">${new Date(order.createdAt || Date.now()).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span><br/>
          <span style="font-size:13px;color:#333;">${paymentLabel} &bull; Total ${money(order.totalAmount)}</span>
        </div>
        <p style="font-size:13px;color:#555;margin:0 0 4px;"><strong>Customer:</strong> ${address.name} (${customerEmail || "no email"})</p>
        <p style="font-size:13px;color:#555;margin:0 0 4px;"><strong>Phone:</strong> ${address.phone || "-"}</p>
        <p style="font-size:13px;color:#555;margin:0 0 16px;"><strong>Address:</strong> ${address.address || ""}, ${address.city || ""}, ${address.state || ""} ${address.pincode || ""}</p>
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr><th style="text-align:left;padding:8px 12px;background:#fafafa;font-size:12px;color:#999;text-transform:uppercase;">Item</th><th style="text-align:right;padding:8px 12px;background:#fafafa;font-size:12px;color:#999;text-transform:uppercase;">Amount</th></tr></thead>
          <tbody>${itemsHtml}${summaryHtml}</tbody>
        </table>
      </div>
    </div>
  `;

  const send = (to, subject, html) =>
    transporter.sendMail({ from, to, subject, html });

  // Send to the customer if we have an email.
  if (customerEmail) {
    await send(customerEmail, customerSubject, customerHtml);
  }

  // Notify the store owner.
  if (ownerEmail) {
    await send(ownerEmail, ownerSubject, ownerHtml);
  }
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

console.log({
  cloud: process.env.CLOUDINARY_CLOUD_NAME,
  key: process.env.CLOUDINARY_API_KEY,
  secret: process.env.CLOUDINARY_API_SECRET ? "Loaded" : "Missing",
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});
const PORT = process.env.PORT || 5000;

// Returns uploads allow larger videos (photos + one video).
const returnUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB
    files: 6, // up to 5 photos + 1 video
  },
});
const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
const jwtSecret = process.env.JWT_SECRET;
const razorpayKeyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
const razorpayKeySecret = String(
  process.env.RAZORPAY_KEY_SECRET || ""
).trim();
const razorpayWebhookSecret = String(
  process.env.RAZORPAY_WEBHOOK_SECRET || ""
).trim();
const razorpay =
  razorpayKeyId && razorpayKeySecret
    ? new Razorpay({
        key_id: razorpayKeyId,
        key_secret: razorpayKeySecret,
      })
    : null;

if (
  !process.env.MONGODB_URI ||
  !jwtSecret ||
  !process.env.ADMIN_EMAIL ||
  !process.env.ADMIN_PASSWORD_HASH
) {
  throw new Error(
    "Missing MONGODB_URI, JWT_SECRET, ADMIN_EMAIL, or ADMIN_PASSWORD_HASH environment variable"
  );
}

app.set("trust proxy", 1);
app.use(helmet());
app.use(
  cors({
    origin: [
      "https://www.dealroot.store",
      "https://dealroot.store",
      "https://dealroot-shopping.vercel.app",
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5175"
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  })
);
app.use(
  "/api/payments/razorpay/webhook",
  express.raw({ type: "application/json", limit: "100kb" })
);
app.use(express.json({ limit: "100kb" }));

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many login attempts. Please try again after 15 minutes.",
  },
});

const customerAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts. Please try again after 15 minutes.",
  },
});

const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many payment attempts. Please try again later.",
  },
});

const allowedCategories = [
  "Skincare",
  "Makeup",
  "Haircare",
  "Fragrance",
  "Bath & Body",
];

const allowedDealTypes = ["none", "99", "199"];

const orderStatuses = [
  "placed",
  "confirmed",
  "packed",
  "shipped",
  "delivered",
  "cancelled",
];
const couponSchema = new mongoose.Schema(
  
  {
    code: {
      type: String,
      unique: true,
      uppercase: true,
      trim: true,
    },

    discountType: {
      type: String,
      enum: ["percentage", "flat"],
      default: "percentage",
    },

    discountValue: Number,

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
  },
  { timestamps: true }
);
const bannerSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      default: "Offer Banner",
      trim: true,
    },

    subtitle: {
      type: String,
      default: "",
      trim: true,
    },

    couponCode: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },

    buttonText: {
      type: String,
      default: "Shop Now",
      trim: true,
    },

    buttonLink: {
      type: String,
      default: "/products",
      trim: true,
    },

    image: {
      type: String,
      default: "",
    },

    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

const productSchema = new mongoose.Schema(
  {
    brand: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    category: {
      type: String,
      required: true,
      trim: true,
    },
    price: { type: Number, required: true, min: 0 },
    mrp: { type: Number, required: true, min: 0 },
   rating: {
  type: Number,
  default: 0,
  min: 0,
  max: 5,
},

reviews: {
  type: Number,
  default: 0,
},
    images: [
  {
    type: String,
  },
],
    badge: { type: String, default: "" },
    stock: { type: Number, default: 20, min: 0 },
    isFeatured: { type: Boolean, default: false },
    tryoutOnly: { type: Boolean, default: false },
    dealType: {
      type: String,
      enum: allowedDealTypes,
      default: "none",
      index: true,
    },
    marketplaceLinks: [
      {
        platform: { type: String, trim: true },
        url: { type: String, trim: true },
      },
    ],
    buyLink: { type: String, trim: true, default: "" },
    buyLinkLabel: { type: String, trim: true, default: "Buy Now" },
    buyLinkTerms: { type: String, trim: true, default: "" },
    specifications: [
      {
        label: { type: String, trim: true },
        value: { type: String, trim: true },
      },
    ],
    highlights: [{ type: String, trim: true }],
  },
  { timestamps: true }
);
const reviewSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    review: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    verifiedPurchase: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

const orderSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    orderNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    customer: {
      name: { type: String, required: true, trim: true },
      email: { type: String, default: "", trim: true, lowercase: true },
      phone: { type: String, required: true, trim: true },
      state: { type: String, required: true, trim: true },
      address: { type: String, required: true, trim: true },
      city: { type: String, required: true, trim: true },
      pincode: { type: String, required: true, trim: true },
    },
    items: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
          required: true,
        },
        brand: { type: String, default: "" },
        title: { type: String, required: true },
        images: [
  {
    type: String,
  },
],
        price: { type: Number, required: true, min: 0 },
        quantity: { type: Number, required: true, min: 1 },
        subtotal: { type: Number, required: true, min: 0 },
      },
    ],
    deliveryFee: { type: Number, default: 0, min: 0 },
    couponCode: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },
    discountAmount: { type: Number, default: 0, min: 0 },
    totalAmount: {
  type: Number,
  required: true,
  min: 0,
},
  
    deliveryType: {
      type: String,
      enum: ["local", "courier"],
      default: "courier",
    },
    paymentMethod: {
      type: String,
      enum: ["cod", "razorpay"],
      default: "cod",
    },
    paymentStatus: {
      type: String,
      enum: [
  "pending",
  "partially_paid",
  "paid",
  "failed",
  "refunded",
],
      default: "pending",
    },
    deliveryChargePaid: {
  type: Boolean,
  default: false,
},

deliveryChargeAmount: {
  type: Number,
  default: 0,
},

codAmount: {
  type: Number,
  default: 0,
},

    razorpayOrderId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    razorpayPaymentId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    razorpaySignature: {
      type: String,
      default: "",
      trim: true,
    },
    paymentCapturedAt: {
      type: Date,
      default: null,
    },
    orderStatus: {
      type: String,
      enum: orderStatuses,
      default: "placed",
    },
    // Timestamped history of every status change (newest last) — powers the
    // customer's order status timeline.
    statusHistory: [
      {
        status: { type: String, enum: orderStatuses },
        at: { type: Date, default: Date.now },
      },
    ],
    stockRestored: { type: Boolean, default: false },
    cancelledAt: { type: Date, default: null },
    // True when the order contains at least one Tryout-exclusive product.
    tryoutOrder: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Seed the status timeline for brand-new orders (Placed at creation time).
// NOTE: Mongoose 9 passes `next` as an object, so use the async-hook style.
orderSchema.pre("save", async function () {
  if (!this.statusHistory || this.statusHistory.length === 0) {
    this.statusHistory = [
      { status: this.orderStatus || "placed", at: new Date() },
    ];
  }
});

const paymentSessionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    orderNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    customer: {
      name: { type: String, required: true, trim: true },
      phone: { type: String, required: true, trim: true },
      state: { type: String, required: true, trim: true },
      address: { type: String, required: true, trim: true },
      city: { type: String, required: true, trim: true },
      pincode: { type: String, required: true, trim: true },
    },
    items: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
          required: true,
        },
        brand: { type: String, default: "" },
        title: { type: String, required: true },
        images: [
  {
    type: String,
  },
],
        price: { type: Number, required: true, min: 0 },
        quantity: { type: Number, required: true, min: 1 },
        subtotal: { type: Number, required: true, min: 0 },
      },
    ],
    deliveryFee: { type: Number, default: 0, min: 0 },
    couponCode: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },
    discountAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },

payableNow: {
  type: Number,
  required: true,
  min: 0,
},

codAmount: {
  type: Number,
  default: 0,
},

paymentMethod: {
  type: String,
  enum: ["cod", "razorpay"],
  default: "razorpay",
},

amountInPaise: { type: Number, required: true, min: 1 },
    deliveryType: {
      type: String,
      enum: ["local", "courier"],
      required: true,
    },
    razorpayOrderId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    razorpayPaymentId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["created", "paid", "refund_pending", "refunded", "failed"],
      default: "created",
      index: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    refundId: {
      type: String,
      default: "",
      trim: true,
    },
    tryoutOrder: { type: Boolean, default: false },
    expiresAt: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 },
    },
  },
  { timestamps: true }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: { type: String, required: true, select: false },
    resetOTP: {
  type: String,
  default: null,
  resetOTP: {
  type: String,
  default: "",
},

otpExpiry: {
  type: Date,
},
},

otpExpiry: {
  type: Date,
  default: null,
},
    phone: { type: String, default: "", trim: true },
    address: { type: String, default: "", trim: true },
    state: { type: String, default: "Uttar Pradesh", trim: true },
    city: { type: String, default: "Kanpur", trim: true },
    pincode: { type: String, default: "", trim: true },
    pendingEmail: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },
    pendingPhone: { type: String, default: "", trim: true },
    changeOTP: { type: String, default: "" },
    addresses: [
      {
        name: { type: String, default: "", trim: true },
        phone: { type: String, default: "", trim: true },
        address: { type: String, default: "", trim: true },
        state: { type: String, default: "", trim: true },
        city: { type: String, default: "", trim: true },
        pincode: { type: String, default: "", trim: true },
        isDefault: { type: Boolean, default: false },
      },
    ],
  },
  { timestamps: true }
);

const Product = mongoose.model("Product", productSchema);
const Coupon = mongoose.model("Coupon", couponSchema);
const Banner = mongoose.model("Banner", bannerSchema);
const Review = mongoose.model("Review", reviewSchema);
const Order = mongoose.model("Order", orderSchema);
const PaymentSession = mongoose.model(
  "PaymentSession",
  paymentSessionSchema
);
const User = mongoose.model("User", userSchema);

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    emoji: { type: String, default: "✨" },
    color: { type: String, default: "#f5f5f5" },
  },
  { timestamps: true }
);

const Category = mongoose.model("Category", categorySchema);

// Categories API — stored server-side so every browser/device sees the same list.
app.get("/api/categories", async (req, res) => {
  try {
    const list = await Category.find().sort({ createdAt: 1 });
    res.json({ success: true, categories: list });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load categories" });
  }
});

app.post("/api/categories", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();

    if (!name) {
      return res.status(400).json({ success: false, message: "Category name is required" });
    }

    const existing = (await Category.find({}).select("name")).find(
      (c) => c.name.toLowerCase() === name.toLowerCase()
    );

    if (existing) {
      return res
        .status(409)
        .json({ success: false, message: `Category "${name}" already exists` });
    }

    const category = await Category.create({
      name,
      emoji: String(req.body.emoji || "✨").trim() || "✨",
      color: String(req.body.color || "#f5f5f5").trim() || "#f5f5f5",
    });

    res.json({ success: true, category });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not add category" });
  }
});

app.delete("/api/categories/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();

    const result = await Category.deleteOne({ name });

    if (!result.deletedCount) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not remove category" });
  }
});



const readBearerToken = (req) =>
  req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : "";

const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
phone: user.phone,
address: user.address,
state: user.state,
city: user.city,
  pincode: user.pincode,
  addresses: user.addresses || [],
});

const requireAdmin = (req, res, next) => {
  const token = readBearerToken(req);

  try {
    const payload = jwt.verify(token, jwtSecret);

    if (payload.role !== "admin") {
      throw new Error("Invalid role");
    }

    req.admin = payload;
    next();
  } catch {
    res.status(401).json({
      success: false,
      message: "Please log in as an admin.",
    });
  }
};

const requireUser = (req, res, next) => {
  try {
    const payload = jwt.verify(readBearerToken(req), jwtSecret);

    if (payload.role !== "user" || !payload.userId) {
      throw new Error("Invalid role");
    }

    req.user = payload;
    next();
  } catch {
    res.status(401).json({
      success: false,
      message: "Please log in to your customer account.",
    });
  }
};

const optionalUser = (req, _res, next) => {
  const token = readBearerToken(req);

  if (token) {
    try {
      const payload = jwt.verify(token, jwtSecret);
      if (payload.role === "user" && payload.userId) req.user = payload;
    } catch {
      req.user = null;
    }
  }

  next();
};

const sanitizeMarketplaceLinks = (links) => {
  if (!Array.isArray(links)) return [];

  return links
    .map((link) => ({
      platform: String(link?.platform || "").trim(),
      url: String(link?.url || "").trim(),
    }))
    .filter(({ platform, url }) => platform && /^https:\/\//i.test(url))
    .slice(0, 3);
};

const validateProduct = ({
  brand,
  title,
  category,
  price,
  mrp,
  dealType = "none",
}) => {
  const normalizedDealType = String(dealType);
  const effectivePrice =
    normalizedDealType === "none" ? Number(price) : Number(normalizedDealType);

  if (!brand || !title || !category || price === "" || mrp === "") {
    return "Brand, title, category, price and MRP are required";
  }

  if (!category || String(category).trim().length > 60) {
    return "Please choose a valid category";
  }

  if (!allowedDealTypes.includes(normalizedDealType)) {
    return "Please choose a valid deal section";
  }

  if (
    !Number.isFinite(effectivePrice) ||
    !Number.isFinite(Number(mrp)) ||
    effectivePrice < 0 ||
    Number(mrp) < 0
  ) {
    return "Price and MRP must be valid positive numbers";
  }

  if (Number(mrp) < effectivePrice) {
    return "MRP cannot be lower than selling price";
  }

  return null;
};

const productPayload = (body) => {
  const dealType = allowedDealTypes.includes(String(body.dealType))
    ? String(body.dealType)
    : "none";

  return {
    ...body,
    dealType,
    price: dealType === "none" ? Number(body.price) : Number(dealType),
    mrp: Number(body.mrp),
    rating: Number(body.rating || 0),
    reviews: Number(body.reviews || 0),
    stock: Number(body.stock || 0),

    images: Array.isArray(body.images)
      ? body.images
          .map((img) => String(img).trim())
          .filter(Boolean)
      : [],

    isFeatured: Boolean(body.isFeatured),
    tryoutOnly: Boolean(body.tryoutOnly),
    marketplaceLinks: sanitizeMarketplaceLinks(body.marketplaceLinks),
    buyLink: String(body.buyLink || "").trim(),
    buyLinkLabel: String(body.buyLinkLabel || "").trim(),
    buyLinkTerms: String(body.buyLinkTerms || "").trim(),

    specifications: Array.isArray(body.specifications)
      ? body.specifications
          .map((spec) => ({
            label: String(spec?.label || "").trim(),
            value: String(spec?.value || "").trim(),
          }))
          .filter((spec) => spec.label && spec.value)
          .slice(0, 30)
      : [],

    highlights: Array.isArray(body.highlights)
      ? body.highlights
          .map((item) => String(item || "").trim())
          .filter(Boolean)
          .slice(0, 15)
      : [],
  };
};

const createOrderNumber = () =>
  `DR-${Date.now()}-${crypto.randomInt(1000, 10000)}`;

const getRazorpay = () => {
  if (!razorpay) {
    const error = new Error(
      "Online payment is not configured. Please choose Cash on Delivery."
    );
    error.statusCode = 503;
    throw error;
  }

  return razorpay;
};

const cleanDeliveryCustomer = (customer) => ({
  name: String(customer?.name || "").trim(),
  email: String(customer?.email || "").trim().toLowerCase(),
  phone: String(customer?.phone || "").replace(/\D/g, ""),
  state: String(customer?.state || "").trim(),
  address: String(customer?.address || "").trim(),
  city: String(customer?.city || "").trim(),
  pincode: String(customer?.pincode || "").replace(/\D/g, ""),
});

const validateDeliveryCustomer = (customer) => {
  if (
  !customer.name ||
  !customer.state ||
  !customer.address ||
  !customer.city ||
  customer.phone.length !== 10 ||
  customer.pincode.length !== 6
)
  {
    throw new Error("Please enter valid delivery details");
  }
};

const normaliseCouponCode = (couponCode) =>
  String(couponCode || "").trim().toUpperCase();

const roundMoney = (amount) =>
  Math.round((Number(amount) + Number.EPSILON) * 100) / 100;

const buildOnlinePaymentQuote = async ({
  customer,
  items,
  couponCode,
  paymentMethod = "razorpay",
  userId = null,
}) => {
  const cleanCustomer = cleanDeliveryCustomer(customer);
  validateDeliveryCustomer(cleanCustomer);

  if (!Array.isArray(items) || !items.length) {
    throw new Error("Your cart is empty");
  }

  const requestedProducts = new Map();

  for (const item of items) {
    const productId = String(item?.productId || "");
    const quantity = Number(item?.quantity);

    if (
      !mongoose.Types.ObjectId.isValid(productId) ||
      !Number.isInteger(quantity) ||
      quantity < 1
    ) {
      throw new Error("Invalid product or quantity in cart");
    }

    requestedProducts.set(
      productId,
      (requestedProducts.get(productId) || 0) + quantity
    );
  }

  const orderItems = [];
  let subtotal = 0;
  let hasTryoutItem = false;

  for (const [productId, quantity] of requestedProducts.entries()) {
    const product = await Product.findById(productId);

    if (!product || product.stock < quantity) {
      throw new Error(
        "A product is unavailable or does not have enough stock"
      );
    }

    if (product.tryoutOnly) {
      hasTryoutItem = true;

      const tryoutMember = userId
        ? await TryoutApplication.findOne({
            user: userId,
            status: "approved",
          })
        : null;

      if (!tryoutMember) {
        throw new Error(
          "This product is exclusive to approved Tryout members. Kindly apply for the Tryout program first."
        );
      }
    }

    const lineTotal = roundMoney(product.price * quantity);
    subtotal = roundMoney(subtotal + lineTotal);

    orderItems.push({
      product: product._id,
      brand: product.brand,
      title: product.title,
     images: product.images || [],
      price: product.price,
      quantity,
      subtotal: lineTotal,
    });
  }

  const normalizedCoupon = normaliseCouponCode(couponCode);

  if (normalizedCoupon && normalizedCoupon !== "WELCOME10") {
    throw new Error("Invalid coupon code");
  }

  let discountAmount = 0;

  if (normalizedCoupon === "WELCOME10") {
    if (subtotal <= 499) {
      throw new Error(
        "WELCOME10 applies only when the cart subtotal is above â‚¹499"
      );
    }

    discountAmount = Math.round(subtotal * 0.1);
  }

  const normalizedCity = cleanCustomer.city
    .toLowerCase()
    .replace(/\s+/g, " ");
  const isKanpurAddress = normalizedCity.includes("kanpur");
  const deliveryFee =
    subtotal >= 499 ? 0 : isKanpurAddress ? 29 : 49;
 const totalAmount = roundMoney(
  subtotal - discountAmount + deliveryFee
);

const isCod = paymentMethod === "cod";

const payableNow = roundMoney(
  isCod ? deliveryFee : totalAmount
);

const codAmount = roundMoney(
  isCod ? totalAmount - deliveryFee : 0
);

const amountInPaise = Math.round(payableNow * 100);
  if (amountInPaise < 1) {
    throw new Error("Order total must be greater than zero");
  }

  return {
    cleanCustomer,
    orderItems,
    subtotal,
    deliveryFee,
    couponCode: normalizedCoupon,
    discountAmount,
    totalAmount,
    amountInPaise,
    payableNow,
    codAmount,
    deliveryType: isKanpurAddress ? "local" : "courier",
    tryoutOrder: hasTryoutItem,
  };
};

const signaturesMatch = (received, expected) => {
  const receivedBuffer = Buffer.from(String(received || ""), "utf8");
  const expectedBuffer = Buffer.from(String(expected || ""), "utf8");

  return (
    receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  );
};

const getCapturedRazorpayPayment = async ({
  razorpayOrderId,
  razorpayPaymentId,
  amountInPaise,
}) => {
  const instance = getRazorpay();
  let payment = await instance.payments.fetch(razorpayPaymentId);

  if (
    payment.order_id !== razorpayOrderId ||
    Number(payment.amount) !== Number(amountInPaise) ||
    String(payment.currency).toUpperCase() !== "INR"
  ) {
    const error = new Error("Payment details do not match this order");
    error.statusCode = 400;
    throw error;
  }

  if (payment.status === "authorized") {
    payment = await instance.payments.capture(
      razorpayPaymentId,
      amountInPaise,
      "INR"
    );
  }

  if (payment.status !== "captured" || payment.captured !== true) {
    const error = new Error(
      "Payment has not been captured. Please do not retry payment yet."
    );
    error.statusCode = 409;
    throw error;
  }

  return payment;
};

const finaliseRazorpayPayment = async ({
  paymentSessionRecord,
  payment,
  razorpaySignature = "",
}) => {
  if (
    paymentSessionRecord.status === "paid" &&
    paymentSessionRecord.order
  ) {
    return Order.findById(paymentSessionRecord.order);
  }

  const databaseSession = await mongoose.startSession();
  let completedOrder = null;

  try {
    await databaseSession.withTransaction(async () => {
      const currentPaymentSession = await PaymentSession.findById(
        paymentSessionRecord._id
      ).session(databaseSession);

      if (!currentPaymentSession) {
        throw new Error("Payment session not found");
      }

      if (
        currentPaymentSession.status === "paid" &&
        currentPaymentSession.order
      ) {
        completedOrder = await Order.findById(
          currentPaymentSession.order
        ).session(databaseSession);
        return;
      }

      if (
        ["refund_pending", "refunded"].includes(
          currentPaymentSession.status
        )
      ) {
        const error = new Error(
          "This payment is already being refunded"
        );
        error.statusCode = 409;
        error.code = "PAYMENT_REFUND_IN_PROGRESS";
        throw error;
      }

      for (const item of currentPaymentSession.items) {
        const stockUpdate = await Product.updateOne(
          {
            _id: item.product,
            stock: { $gte: item.quantity },
          },
          { $inc: { stock: -item.quantity } },
          { session: databaseSession }
        );

        if (stockUpdate.modifiedCount !== 1) {
          const error = new Error(
            "A product sold out while payment was processing"
          );
          error.code = "OUT_OF_STOCK_AFTER_PAYMENT";
          throw error;
        }
      }

      [completedOrder] = await Order.create(
        [
          {
            orderNumber: currentPaymentSession.orderNumber,
            user: currentPaymentSession.user,
            customer: currentPaymentSession.customer,
            items: currentPaymentSession.items,
            deliveryFee: currentPaymentSession.deliveryFee,
            couponCode: currentPaymentSession.couponCode,
            discountAmount: currentPaymentSession.discountAmount,
            totalAmount: currentPaymentSession.totalAmount,
            deliveryType: currentPaymentSession.deliveryType,
            paymentMethod: currentPaymentSession.paymentMethod,
            tryoutOrder: currentPaymentSession.tryoutOrder || false,

paymentStatus:
  currentPaymentSession.paymentMethod === "cod"
    ? "partially_paid"
    : "paid",

deliveryChargePaid:
  currentPaymentSession.paymentMethod === "cod",

deliveryChargeAmount:
  currentPaymentSession.paymentMethod === "cod"
    ? currentPaymentSession.payableNow
    : currentPaymentSession.deliveryFee,

codAmount: currentPaymentSession.codAmount,
            razorpayOrderId: currentPaymentSession.razorpayOrderId,
            razorpayPaymentId: payment.id,
            razorpaySignature,
            paymentCapturedAt: new Date(),
          },
        ],
        { session: databaseSession }
      );

      currentPaymentSession.status = "paid";
      currentPaymentSession.razorpayPaymentId = payment.id;
      currentPaymentSession.order = completedOrder._id;
      await currentPaymentSession.save({ session: databaseSession });

      if (currentPaymentSession.user) {
        await User.findByIdAndUpdate(
          currentPaymentSession.user,
          { $set: currentPaymentSession.customer },
          { session: databaseSession, runValidators: true }
        );
      }
    });

    // Notify customer + owner after a paid order is created.
    if (completedOrder) {
      sendOrderEmails(completedOrder).catch((error) =>
        console.error("Order email failed:", error.message)
      );
    }

    return completedOrder;
  } catch (error) {
    const completedSession = await PaymentSession.findById(
      paymentSessionRecord._id
    );

    if (completedSession?.status === "paid" && completedSession.order) {
      return Order.findById(completedSession.order);
    }

    if (error.code !== "OUT_OF_STOCK_AFTER_PAYMENT") {
      throw error;
    }

    const refundClaim = await PaymentSession.findOneAndUpdate(
      {
        _id: paymentSessionRecord._id,
        status: "created",
      },
      {
        $set: {
          status: "refund_pending",
          razorpayPaymentId: payment.id,
        },
      },
      { new: true }
    );

    if (refundClaim) {
      try {
        const refund = await getRazorpay().payments.refund(payment.id, {
          amount: paymentSessionRecord.amountInPaise,
          speed: "normal",
          receipt: `RF-${paymentSessionRecord.orderNumber}`,
          notes: {
            reason: "Product became unavailable during payment",
          },
        });

        await PaymentSession.findByIdAndUpdate(paymentSessionRecord._id, {
          status: "refunded",
          refundId: refund.id,
        });
      } catch (refundError) {
        console.error(
          "Automatic Razorpay refund failed:",
          refundError.message
        );
      }
    }

    const refundState = await PaymentSession.findById(
      paymentSessionRecord._id
    );
    const refundStarted = refundState?.status === "refunded";
    const refundError = new Error(
      refundStarted
        ? "A product sold out during payment. A full refund has been initiated."
        : "Payment succeeded, but the order needs manual review. Please contact DEALROOT with the payment ID."
    );
    refundError.statusCode = 409;
    refundError.code = refundStarted
      ? "PAYMENT_REFUNDED"
      : "PAYMENT_REVIEW_REQUIRED";
    throw refundError;
  } finally {
    await databaseSession.endSession();
  }
};

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "DEALROOT backend is running",
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "dealroot-backend",
    database:
      mongoose.connection.readyState === 1 ? "connected" : "not connected",
  });
});
// ===========================
// SEO — sitemap.xml + robots.txt
// ===========================
// Canonical STOREFRONT domain (the sitemap lists frontend URLs, not this API).
// Keep in sync with SITE_URL in dealroot-shopping/src/seo/seoConfig.js.
const seoSiteUrl = "https://www.dealroot.store";

app.get("/sitemap.xml", async (req, res) => {
  try {
    const products = await Product.find({})
      .select("title updatedAt")
      .sort({ updatedAt: -1 });

    const staticPages = [
      { path: "/", priority: "1.0", freq: "daily" },
      { path: "/about", priority: "0.6", freq: "monthly" },
      { path: "/brands", priority: "0.6", freq: "monthly" },
      { path: "/contact", priority: "0.5", freq: "monthly" },
      { path: "/become-a-seller", priority: "0.5", freq: "monthly" },
      { path: "/privacy", priority: "0.3", freq: "yearly" },
      { path: "/terms", priority: "0.3", freq: "yearly" },
      { path: "/shipping", priority: "0.4", freq: "yearly" },
      { path: "/refund", priority: "0.4", freq: "yearly" },
    ];

    const pageUrl = function (pagePath) {
      return seoSiteUrl + (pagePath === "/" ? "" : pagePath);
    };

    const urlBlocks = [];

    staticPages.forEach(function (page) {
      urlBlocks.push(
        "  <url>\n" +
          "    <loc>" + pageUrl(page.path) + "</loc>\n" +
          "    <changefreq>" + page.freq + "</changefreq>\n" +
          "    <priority>" + page.priority + "</priority>\n" +
          "  </url>"
      );
    });

    products.forEach(function (product) {
      const lastmod = product.updatedAt
        ? product.updatedAt.toISOString().slice(0, 10)
        : "";
      let block =
        "  <url>\n" +
        "    <loc>" + seoSiteUrl + "/product/" + product._id + "</loc>\n";
      if (lastmod) {
        block += "    <lastmod>" + lastmod + "</lastmod>\n";
      }
      block +=
        "    <changefreq>weekly</changefreq>\n" +
        "    <priority>0.8</priority>\n" +
        "  </url>";
      urlBlocks.push(block);
    });

    const urls = urlBlocks.join("\n");

    res.set("Content-Type", "application/xml");
    res.send(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        urls +
        "\n</urlset>"
    );
  } catch (error) {
    console.error("Sitemap generation failed:", error.message);
    res.status(500).send("Could not generate sitemap");
  }
});

app.get("/robots.txt", function (req, res) {
  res.set("Content-Type", "text/plain");
  res.send(
    [
      "User-agent: *",
      "Allow: /",
      "Disallow: /admin",
      "",
      "Sitemap: " + seoSiteUrl + "/sitemap.xml",
      "Sitemap: https://dealroot-backend.onrender.com/sitemap.xml",
      "",
    ].join("\n")
  );
});

app.post("/api/admin/login", adminLoginLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  const normaliseForComparison = (value) =>
    Buffer.from(String(value).slice(0, 256).padEnd(256));

  const isCorrectEmail = crypto.timingSafeEqual(
    normaliseForComparison(email),
    normaliseForComparison(
      String(process.env.ADMIN_EMAIL).toLowerCase()
    )
  );

  const isCorrectPassword = await bcrypt.compare(
    password,
    process.env.ADMIN_PASSWORD_HASH
  );

  if (!isCorrectEmail || !isCorrectPassword) {
    return res.status(401).json({
      success: false,
      message: "Invalid email or password",
    });
  }

  const token = jwt.sign(
    { role: "admin", email },
    jwtSecret,
    { expiresIn: "8h" }
  );

  res.json({
    success: true,
    token,
    admin: { email },
  });
});

app.post("/api/auth/signup", customerAuthLimiter, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (name.length < 2) {
      return res.status(400).json({ success: false, message: "Please enter your full name" });
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ success: false, message: "Please enter a valid email address" });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
    }

    if (await User.exists({ email })) {
      return res.status(409).json({ success: false, message: "An account with this email already exists" });
    }

    const user = await User.create({
      name,
      email,
      passwordHash: await bcrypt.hash(password, 12),
    });
    const token = jwt.sign({ role: "user", userId: user._id }, jwtSecret, { expiresIn: "7d" });

    res.status(201).json({ success: true, token, user: publicUser(user) });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: "An account with this email already exists" });
    }
    res.status(500).json({ success: false, message: "Could not create your account" });
  }
});

app.post("/api/auth/login", customerAuthLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const user = await User.findOne({ email }).select("+passwordHash");

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    const token = jwt.sign({ role: "user", userId: user._id }, jwtSecret, { expiresIn: "7d" });
    res.json({ success: true, token, user: publicUser(user) });
  } catch {
    res.status(500).json({ success: false, message: "Could not log in" });
  }
});
app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Email not found",
      });
    }

    const otp = Math.floor(
      100000 + Math.random() * 900000
    ).toString();

    user.resetOTP = otp;
    user.otpExpiry = Date.now() + 10 * 60 * 1000;

    await user.save();

    await sendOTP(email, otp);

    res.json({
      success: true,
      message: "OTP sent successfully",
    });

  } catch (err) {

    console.log(err);

    res.status(500).json({
      success: false,
      message: "Failed to send OTP",
    });
  }
});

app.post("/api/auth/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (user.resetOTP !== otp) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP",
      });
    }

    if (!user.otpExpiry || user.otpExpiry < Date.now()) {
      return res.status(400).json({
        success: false,
        message: "OTP expired",
      });
    }

    res.json({
      success: true,
      message: "OTP verified",
    });

  } catch (err) {
    console.log(err);

    res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { email, otp, password } = req.body;

    const user = await User.findOne({
      email,
    }).select("+passwordHash");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (
      user.resetOTP !== otp ||
      !user.otpExpiry ||
      user.otpExpiry < Date.now()
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired OTP",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    user.passwordHash = hashedPassword;
    user.resetOTP = "";
    user.otpExpiry = null;

    await user.save();

    res.json({
      success: true,
      message: "Password reset successfully",
    });

  } catch (err) {
    console.log(err);

    res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
});



// ===========================
// LOGIN & SECURITY
// ===========================
// Change email: the OTP is emailed to the CURRENT email address first, so an
// account can only be moved to a new email by someone who can read its inbox.
app.post("/api/auth/request-email-change", requireUser, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ success: false, message: "Account not found" });

    const newEmail = String(req.body?.newEmail || "").trim().toLowerCase();

    if (!/^\S+@\S+\.\S+$/.test(newEmail)) {
      return res.status(400).json({ success: false, message: "Please enter a valid email address" });
    }

    if (newEmail === user.email) {
      return res.status(400).json({ success: false, message: "This is already your email address" });
    }

    if (await User.exists({ email: newEmail })) {
      return res.status(409).json({ success: false, message: "An account with this email already exists" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.pendingEmail = newEmail;
    user.pendingPhone = "";
    user.changeOTP = otp;
    user.otpExpiry = Date.now() + 10 * 60 * 1000;
    await user.save();

    await sendOTP(
      user.email,
      otp,
      "Dealroot Email Change OTP",
      "Change your email address",
      "Enter this code to confirm changing your DEALROOT email to the new one:"
    );

    res.json({ success: true, message: "OTP sent to your current email" });
  } catch (err) {
    console.log(err);
    res.status(500).json({ success: false, message: "Failed to send OTP" });
  }
});

app.post("/api/auth/verify-email-change", requireUser, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ success: false, message: "Account not found" });

    const otp = String(req.body?.otp || "").trim();

    if (!user.pendingEmail) {
      return res.status(400).json({ success: false, message: "No email change requested. Please request an OTP first." });
    }

    if (user.changeOTP !== otp) {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    if (!user.otpExpiry || user.otpExpiry < Date.now()) {
      return res.status(400).json({ success: false, message: "OTP expired. Please request a new one." });
    }

    // Re-check the new email is still free (another account may have taken
    // it between the request and the verification).
    const takenEmail = await User.exists({
      email: user.pendingEmail,
      _id: { $ne: user._id },
    });

    if (takenEmail) {
      user.pendingEmail = "";
      user.changeOTP = "";
      user.otpExpiry = null;
      await user.save();
      return res.status(409).json({ success: false, message: "An account with this email already exists" });
    }

    user.email = user.pendingEmail;
    user.pendingEmail = "";
    user.changeOTP = "";
    user.otpExpiry = null;
    await user.save();

    res.json({ success: true, message: "Email changed successfully", user: publicUser(user) });
  } catch (err) {
    console.log(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

// Change mobile number: same pattern — OTP emailed to the current email.
app.post("/api/auth/request-phone-change", requireUser, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ success: false, message: "Account not found" });

    const newPhone = String(req.body?.newPhone || "").replace(/\D/g, "");

    if (newPhone.length !== 10) {
      return res.status(400).json({ success: false, message: "Please enter a valid 10-digit mobile number" });
    }

    if (newPhone === user.phone) {
      return res.status(400).json({ success: false, message: "This is already your mobile number" });
    }

    // Reject numbers already registered to another account.
    const takenPhone = await User.exists({
      phone: newPhone,
      _id: { $ne: user._id },
    });

    if (takenPhone) {
      return res.status(409).json({ success: false, message: "An account with this mobile number already exists" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.pendingPhone = newPhone;
    user.pendingEmail = "";
    user.changeOTP = otp;
    user.otpExpiry = Date.now() + 10 * 60 * 1000;
    await user.save();

    await sendOTP(
      user.email,
      otp,
      "Dealroot Mobile Number Change OTP",
      "Change your mobile number",
      "Enter this code to confirm updating your DEALROOT mobile number:"
    );

    res.json({ success: true, message: "OTP sent to your current email" });
  } catch (err) {
    console.log(err);
    res.status(500).json({ success: false, message: "Failed to send OTP" });
  }
});

app.post("/api/auth/verify-phone-change", requireUser, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ success: false, message: "Account not found" });

    const otp = String(req.body?.otp || "").trim();

    if (!user.pendingPhone) {
      return res.status(400).json({ success: false, message: "No mobile change requested. Please request an OTP first." });
    }

    if (user.changeOTP !== otp) {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    if (!user.otpExpiry || user.otpExpiry < Date.now()) {
      return res.status(400).json({ success: false, message: "OTP expired. Please request a new one." });
    }

    // Re-check the new number is still free (another account may have taken
    // it between the request and the verification).
    const takenPhone = await User.exists({
      phone: user.pendingPhone,
      _id: { $ne: user._id },
    });

    if (takenPhone) {
      user.pendingPhone = "";
      user.changeOTP = "";
      user.otpExpiry = null;
      await user.save();
      return res.status(409).json({ success: false, message: "An account with this mobile number already exists" });
    }

    user.phone = user.pendingPhone;
    user.pendingPhone = "";
    user.changeOTP = "";
    user.otpExpiry = null;
    await user.save();

    res.json({ success: true, message: "Mobile number updated successfully", user: publicUser(user) });
  } catch (err) {
    console.log(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

// Change password — always verify the current password first.
app.post("/api/auth/change-password", requireUser, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("+passwordHash");
    if (!user) return res.status(404).json({ success: false, message: "Account not found" });

    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");

    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      return res.status(400).json({ success: false, message: "Current password is incorrect" });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: "New password must be at least 8 characters" });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    await user.save();

    res.json({ success: true, message: "Password changed successfully" });
  } catch (err) {
    console.log(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

app.get("/api/auth/me", requireUser, async (req, res) => {
  const user = await User.findById(req.user.userId);
  if (!user) return res.status(404).json({ success: false, message: "Account not found" });
  res.json({ success: true, user: publicUser(user) });
});

app.put("/api/auth/me", requireUser, async (req, res) => {
  try {
    const body = req.body || {};
    let update;

    if (Array.isArray(body.addresses)) {
      // Address-book mode: validate every address and keep the flat fields in
      // sync with the default address (orders still read the flat fields).
      const cleanAddress = (a) => ({
        name: String(a?.name || "").trim(),
        phone: String(a?.phone || "").replace(/\D/g, ""),
        address: String(a?.address || "").trim(),
        state: String(a?.state || "").trim(),
        city: String(a?.city || "").trim(),
        pincode: String(a?.pincode || "").replace(/\D/g, ""),
        isDefault: Boolean(a?.isDefault),
      });

      const addresses = body.addresses
        .filter(
          (a) =>
            a &&
            (String(a.name || "").trim() ||
              String(a.phone || "").trim() ||
              String(a.address || "").trim() ||
              String(a.state || "").trim() ||
              String(a.city || "").trim() ||
              String(a.pincode || "").trim())
        )
        .map(cleanAddress);

      if (addresses.length > 10)
        throw new Error("You can save up to 10 addresses");

      for (const a of addresses) {
        if (!a.name) throw new Error("Please enter the recipient name for every address");
        if (a.phone.length !== 10)
          throw new Error(`Please enter a valid 10-digit mobile number for ${a.name}`);
        if (!a.address) throw new Error(`Please enter the complete address for ${a.name}`);
        if (!a.city) throw new Error(`Please enter the city for ${a.name}`);
        if (!a.state) throw new Error(`Please enter the state for ${a.name}`);
        if (a.pincode.length !== 6)
          throw new Error(`Please enter a valid 6-digit pincode for ${a.name}`);
      }

      // Exactly one address may be the default: the first one flagged wins
      // and every other is forced off, even if the client sent duplicates.
      const firstDefault = addresses.findIndex((a) => a.isDefault);
      const normalized = addresses.map((a, i) => ({
        ...a,
        isDefault: i === (firstDefault >= 0 ? firstDefault : 0),
      }));
      const defaultAddr = normalized.find((a) => a.isDefault) || normalized[0] || {};

      update = {
        name: String(body.name || "").trim() || defaultAddr.name || "",
        phone:
          String(body.phone || "").replace(/\D/g, "") ||
          defaultAddr.phone ||
          "",
        address: defaultAddr.address || "",
        state: defaultAddr.state || "Uttar Pradesh",
        city: defaultAddr.city || "Kanpur",
        pincode: defaultAddr.pincode || "",
        addresses: normalized,
      };

      if (update.name.length < 2) throw new Error("Please enter your full name");
      if (update.phone && update.phone.length !== 10)
        throw new Error("Please enter a valid 10-digit mobile number");
    } else {
      // Legacy single-address update
      const phone = String(body.phone || "").replace(/\D/g, "");
      const pincode = String(body.pincode || "").replace(/\D/g, "");
      update = {
        name: String(body.name || "").trim(),
        phone,
        address: String(body.address || "").trim(),
        state: String(body.state || "").trim(),
        city: String(body.city || "").trim(),
        pincode,
      };

      if (update.name.length < 2) throw new Error("Please enter your full name");
      if (phone && phone.length !== 10)
        throw new Error("Please enter a valid 10-digit mobile number");
      if (pincode && pincode.length !== 6)
        throw new Error("Please enter a valid 6-digit pincode");
    }

    const user = await User.findByIdAndUpdate(req.user.userId, update, {
      new: true,
      runValidators: true,
    });
    if (!user) return res.status(404).json({ success: false, message: "Account not found" });
    res.json({ success: true, user: publicUser(user) });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message || "Could not save profile" });
  }
});

app.get("/api/auth/orders", requireUser, async (req, res) => {
  const orders = await Order.find({ user: req.user.userId }).sort({ createdAt: -1 });
  res.json({ success: true, count: orders.length, orders });
});

// Public order tracking — no login needed. Look up by order number or email.
app.post("/api/orders/track", async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || "").trim().toUpperCase();
    const email = String(req.body?.email || "").trim().toLowerCase();

    if (!orderId && !email) {
      return res.status(400).json({
        success: false,
        message: "Please enter your order ID or email to track your order",
      });
    }

    let orders = [];

    if (orderId) {
      const order = await Order.findOne({ orderNumber: orderId });
      if (order) orders.push(order);
    }

    if (email) {
      const emailMatches = await Order.find({
        "customer.email": email,
      }).sort({ createdAt: -1 });

      for (const order of emailMatches) {
        if (!orders.some((o) => String(o._id) === String(order._id))) {
          orders.push(order);
        }
      }

      // Older orders may not store the email on the customer record —
      // also match orders placed by a registered account with this email.
      const account = await User.findOne({ email }).select("_id");

      if (account) {
        const accountOrders = await Order.find({
          user: account._id,
        }).sort({ createdAt: -1 });

        for (const order of accountOrders) {
          if (!orders.some((o) => String(o._id) === String(order._id))) {
            orders.push(order);
          }
        }
      }
    }

    if (orders.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No order found. Please double-check your order ID or email.",
      });
    }

    res.json({ success: true, count: orders.length, orders });
  } catch (error) {
    console.error("Track order failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Could not track your order. Please try again.",
    });
  }
});

app.get("/api/products", async (req, res) => {
  try {
    const { category, search, featured, dealType } = req.query;
    const filter = {};

    if (category && category !== "All") {
      filter.category = category;
    }

    if (featured === "true") {
      filter.isFeatured = true;
    }

    if (dealType && dealType !== "none") {
      if (!allowedDealTypes.includes(String(dealType))) {
        return res.status(400).json({
          success: false,
          message: "Please choose a valid deal section",
        });
      }

      // Price-based automatic filtering: the ₹99 deal shows every
      // product priced at or below ₹99, the ₹199 deal everything
      // at or below ₹199 — no manual dealType tagging needed.
      const dealLimit = Number(dealType);
      if (Number.isFinite(dealLimit) && dealLimit > 0) {
        filter.price = { $lte: dealLimit };
      } else {
        filter.dealType = String(dealType);
      }
    }

    if (search) {
      filter.$or = ["title", "brand", "category"].map((key) => ({
        [key]: {
          $regex: String(search),
          $options: "i",
        },
      }));
    }

    const products = await Product.find(filter).sort({ createdAt: -1 });

    res.json({
      success: true,
      count: products.length,
      products,
    });
  } catch {
    res.status(500).json({
      success: false,
      message: "Could not load products",
    });
  }
});

app.get("/api/products/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.json({ success: true, product });
  } catch {
    res.status(400).json({
      success: false,
      message: "Invalid product id",
    });
  }
});

app.get("/api/reviews/:productId", async (req, res) => {
  try {
    const reviews = await Review.find({
      product: req.params.productId,
    })
      .populate("user", "name")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      reviews,
    });
  } catch {
    res.status(500).json({
      success: false,
      message: "Could not load reviews",
    });
  }
});
app.post("/api/reviews", requireUser, async (req, res) => {
  try {
    const productId = String(req.body?.productId || "");
    const rating = Number(req.body?.rating);
    const review = String(req.body?.review || "").trim();

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product",
      });
    }

    if (
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5
    ) {
      return res.status(400).json({
        success: false,
        message: "Rating must be between 1 and 5",
      });
    }

    if (review.length < 5) {
      return res.status(400).json({
        success: false,
        message: "Please write a longer review",
      });
    }

    const product = await Product.findById(productId);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const purchasedOrder = await Order.findOne({
      user: req.user.userId,
      orderStatus: "delivered",
      "items.product": productId,
    });

    if (!purchasedOrder) {
      return res.status(403).json({
        success: false,
        message: "Only customers who purchased this product can review it",
      });
    }

    const alreadyReviewed = await Review.findOne({
      user: req.user.userId,
      product: productId,
    });

    if (alreadyReviewed) {
      return res.status(409).json({
        success: false,
        message: "You have already reviewed this product",
      });
    }

    const newReview = await Review.create({
      product: productId,
      user: req.user.userId,
      order: purchasedOrder._id,
      rating,
      review,
      verifiedPurchase: true,
    });

    await updateProductRating(productId);

    const populatedReview = await Review.findById(newReview._id)
      .populate("user", "name");

    res.status(201).json({
      success: true,
      message: "Review submitted successfully",
      review: populatedReview,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "Could not submit review",
    });
  }
});
// ===========================
// AI SCREENSHOT EXTRACTION
// ===========================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// Extract product info (specs + highlights) from a product screenshot
// using Google Gemini vision. Returns structured JSON.
const extractProductFromScreenshot = async (
  imageBuffer,
  mimeType,
  contextText = ""
) => {
  const model = "gemini-flash-latest";
  const prompt = `
You are a product data extraction assistant for an e-commerce store.
Look at this product image (from Amazon, Flipkart, Myntra or any store)
and extract the product details into strict JSON with this EXACT shape:

{
  "brand": "string",
  "title": "string",
  "price": 0,
  "mrp": 0,
  "description": "string",
  "specifications": [ { "label": "string", "value": "string" } ],
  "highlights": [ "string" ]
}

${
    contextText
      ? `Known context about this product (use it to fill brand/title/specs even if the image is a packshot):\n${contextText}\n\n`
      : ""
  }
Rules:
- specifications: key-value pairs like { "label": "Hair Type", "value": "All" },
  { "label": "Scent", "value": "Rosemary Oil Shots" }, { "label": "Liquid Volume", "value": "48 Millilitres" },
  { "label": "Brand", "value": "..." }, { "label": "Number of Items", "value": "8" },
  { "label": "Net Quantity", "value": "..." }, { "label": "Item Form", "value": "Oil" }.
  Extract as many real labels/values as visible. Skip unknown ones.
- highlights: short bullet phrases like "Improves blood circulation to the scalp",
  "Deeply nourishes the scalp", "Strengthens hair follicles reducing breakage" (max 8).
- price/mrp: numeric values only (strip currency symbols). Use 0 when unknown.
- Return ONLY valid JSON. No markdown, no extra text.
`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  let response;

  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: imageBuffer.toString("base64"),
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2048,
            responseMimeType: "application/json",
          },
        }),
        signal: controller.signal,
      }
    );
  } catch (fetchError) {
    if (fetchError.name === "AbortError") {
      throw new Error("AI request timed out. Please try again.");
    }
    throw fetchError;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errorText.slice(0, 300)}`);
  }

  const data = await response.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

  // Strip markdown fences if present, then parse JSON
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed;

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      "AI se sahi data nahi mila. Clear / close-up screenshot try karein."
    );
  }

  // Some models return an array of detected products — pick the first/main one
  if (Array.isArray(parsed)) {
    parsed = parsed[0] && typeof parsed[0] === "object" ? parsed[0] : {};
  }

  const pick = (node, key) =>
    node && typeof node === "object" ? node[key] : undefined;

  // If brand/title/price are nested (e.g. inside .product or .data), unwrap
  let dataNode = parsed;
  if (
    !pick(dataNode, "title") &&
    typeof dataNode.product === "object"
  ) {
    dataNode = dataNode.product;
  }

  return {
    brand: String(pick(dataNode, "brand") || ""),
    title: String(pick(dataNode, "title") || ""),
    price: Number(pick(dataNode, "price")) || 0,
    mrp: Number(pick(dataNode, "mrp")) || 0,
    description: String(pick(dataNode, "description") || ""),
    specifications: Array.isArray(pick(dataNode, "specifications"))
      ? pick(dataNode, "specifications")
          .map((spec) => ({
            label: String(spec?.label || "").trim(),
            value: String(spec?.value || "").trim(),
          }))
          .filter((spec) => spec.label && spec.value)
          .slice(0, 30)
      : [],
    highlights: Array.isArray(pick(dataNode, "highlights"))
      ? pick(dataNode, "highlights")
          .map((item) => String(item).trim())
          .filter(Boolean)
          .slice(0, 15)
      : [],
  };
};

// Upload a single image buffer to Cloudinary and return the secure URL
const uploadBufferToCloudinary = (buffer) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "dealroot-products",
        transformation: [
          {
            width: 800,
            height: 800,
            crop: "fill",
            gravity: "auto",
            quality: "auto",
            fetch_format: "auto",
          },
        ],
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });

// Pull REAL product image URLs out of raw page HTML.
// Strategy (highest priority first):
//   1. Amazon "colorImages" JSON — the actual product gallery (MAIN variant first)
//   2. og:image / twitter:image
//   3. JSON-LD Product images
//   4. Generic m.media-amazon.com/images/I/... photos (suffix stripped)
//   5. Generic src patterns (de-prioritized)
// Junk (CSS/JS/sprites/logos/promos) is filtered out.
const extractProductImagesFromHtml = (html, baseUrl) => {
  const found = [];

  const push = (url, priority) => {
    if (!url || typeof url !== "string") return;
    url = url.trim();
    if (!/^https?:\/\//i.test(url)) return;
    if (/\.(css|js|gif|svg)(\?|$)/i.test(url)) return;
    if (/sprite|sprites|logo|icon|badge|promo|banner|_CB\d/i.test(url)) return;
    const clean = url.split("?")[0];
    if (!found.some((f) => f.url === clean)) {
      found.push({ url: clean, priority });
    }
  };

  // 1) Amazon colorImages JSON — e.g.
  //    "colorImages":{"6 ml (Pack of 8)":[{"large":"...jpg","variant":"MAIN",...}]}
  const colorIndex = html.indexOf('"colorImages"');
  if (colorIndex !== -1) {
    const colon = html.indexOf(":", colorIndex + 12);
    const start = html.indexOf("{", colon);
    if (start !== -1) {
      let depth = 0;
      let end = start;
      for (; end < Math.min(html.length, start + 3000000); end++) {
        if (html[end] === "{") depth++;
        else if (html[end] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      try {
        const parsed = JSON.parse(html.slice(start, end + 1));
        const entries = [];
        Object.values(parsed).forEach((arr) => {
          if (!Array.isArray(arr)) return;
          arr.forEach((img) => {
            if (img && typeof img === "object") {
              const large = img.large || img.hiRes || "";
              if (large) {
                entries.push({
                  url: large,
                  isMain: img.variant === "MAIN",
                });
              }
            }
          });
        });
        entries.sort((a, b) => Number(b.isMain) - Number(a.isMain));
        entries.forEach((e) => push(e.url, 10));
      } catch {
        // ignore malformed JSON
      }
    }
  }

  // 2) og:image / twitter:image
  const ogMatch = html.match(
    /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i
  );
  if (ogMatch) push(ogMatch[1], 6);

  const twitterMatch = html.match(
    /<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i
  );
  if (twitterMatch) push(twitterMatch[1], 5);

  // 3) JSON-LD Product images
  const jsonLdBlocks =
    html.match(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ) || [];

  for (const block of jsonLdBlocks) {
    const text = block.replace(/<\/?script[^>]*>/gi, "");
    try {
      const parsed = JSON.parse(text);
      const collect = (node) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
          node.forEach(collect);
          return;
        }
        const nodeTypes = Array.isArray(node["@type"])
          ? node["@type"]
          : [node["@type"]];

        if (nodeTypes.includes("Product") && node.image) {
          const imgs = Array.isArray(node.image)
            ? node.image
            : [node.image];
          imgs.forEach((img) => {
            const src = typeof img === "string" ? img : img?.url;
            if (src) push(src, 4);
          });
        }
        Object.values(node).forEach(collect);
      };
      collect(parsed);
    } catch {
      // ignore malformed JSON-LD
    }
  }

  // 4) Amazon media images (images/I/....jpg), suffix stripped to the base photo
  const amazonRe =
    /https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9+\-_.]+\.(?:jpg|jpeg|webp|png)/g;
  const bases = new Set();
  for (const m of html.match(amazonRe) || []) {
    const base = m.replace(
      /\._[A-Z0-9_,-]+_\.(jpg|jpeg|webp|png)$/i,
      ".$1"
    );
    if (!/\.(css|js|gif)(\?|$)/i.test(base)) bases.add(base);
  }
  [...bases].slice(0, 10).forEach((b) => push(b, 3));

  // 5) Generic src patterns (large/product/image keywords) as last resort.
  // NOTE: srcset is deliberately excluded — it contains comma-separated URLs
  // with size descriptors that would produce malformed URLs.
  const srcMatches =
    html.match(
      /(?:data-src|src)=["'](https?:\/\/[^"']*(?:large|product|image)[^"']*\.(?:jpg|jpeg|png|webp))["']/gi
    ) || [];

  srcMatches.slice(0, 8).forEach((match) => {
    const url = match.match(/["']([^"']+)["']/)?.[1];
    if (url) push(url, 2);
  });

  return found
    .map((f) => {
      try {
        return { url: new URL(f.url, baseUrl).href, priority: f.priority };
      } catch {
        return f;
      }
    })
    .filter((f, index, array) => array.findIndex((x) => x.url === f.url) === index)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 10)
    .map((f) => f.url);
};

// FirstCry renders its product gallery via JavaScript, so the raw HTML only
// contains the og:image. Its CDN stores every gallery shot as
//   https://cdn.fcglcdn.com/brainbees/images/products/zoom/{slug}-{productId}{letter}.jpg
// where {letter} runs a, b, c, ... Probe those URLs (cheap Range requests) and
// return the ones that actually exist.
const extractFirstCryGalleryImages = async (html, baseUrl) => {
  const ogMatch = html.match(
    /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i
  );
  const ogUrl = ogMatch?.[1];

  if (!ogUrl || !/cdn\.fcglcdn\.com\/[^"']*\/products\/zoom\//i.test(ogUrl)) {
    return [];
  }

  let base;
  try {
    const parsed = new URL(ogUrl, baseUrl);
    const filename = parsed.pathname.split("/").pop() || "";
    // "...-1560634zzsq.jpg" -> strip the size marker + extension
    const stripped = filename.replace(
      /(?:zzsq|zz|zoom)?\.(?:jpe?g|png|webp)$/i,
      ""
    );
    base =
      parsed.origin +
      parsed.pathname.slice(0, parsed.pathname.length - filename.length) +
      stripped;
  } catch {
    return [];
  }

  const found = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    for (const letter of "abcdefghij".split("")) {
      const url = base + letter + ".jpg";
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": UA, Range: "bytes=0-1023" },
          signal: controller.signal,
        });
        if (!res.ok) break; // gallery letters are contiguous — stop at first miss
        const type = res.headers.get("content-type") || "";
        if (!/^image\//i.test(type)) break;
        found.push(url);
      } catch {
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  return found;
};

app.post(
  "/api/products/extract-info",
  requireAdmin,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!GEMINI_API_KEY) {
        return res.status(503).json({
          success: false,
          message:
            "GEMINI_API_KEY is not set in the backend .env file. Get a free key at https://aistudio.google.com/apikey and add it, then restart the backend.",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Please choose a screenshot image",
        });
      }

      const info = await extractProductFromScreenshot(
        req.file.buffer,
        req.file.mimetype || "image/png"
      );

      // Also keep the screenshot itself as a product image candidate
      let screenshotUrl = "";

      try {
        screenshotUrl = await uploadBufferToCloudinary(req.file.buffer);
      } catch {
        screenshotUrl = "";
      }

      res.json({
        success: true,
        info,
        images: screenshotUrl ? [screenshotUrl] : [],
      });
    } catch (error) {
      console.error("AI extraction failed:", error.message);
      res.status(500).json({
        success: false,
        message: error.message || "Could not extract product info",
      });
    }
  }
);

app.post(
  "/api/products/extract-from-link",
  requireAdmin,
  async (req, res) => {
    try {
      if (!GEMINI_API_KEY) {
        return res.status(503).json({
          success: false,
          message:
            "GEMINI_API_KEY is not set in the backend .env file. Get a free key at https://aistudio.google.com/apikey and add it, then restart the backend.",
        });
      }

      const url = String(req.body?.url || "").trim();

      if (!/^https?:\/\//i.test(url)) {
        return res.status(400).json({
          success: false,
          message: "Valid product link paste karein (https://...)",
        });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      let pageResponse;

      try {
        pageResponse = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
            "Accept-Language": "en-IN,en;q=0.9,hi;q=0.8",
          },
          redirect: "follow",
          signal: controller.signal,
        });
      } catch (fetchError) {
        if (fetchError.name === "AbortError") {
          throw new Error("Link se page load nahi hua — timeout. Dobara try karein.");
        }
        throw new Error("Product page khul nahi paayi. Link check karein.");
      } finally {
        clearTimeout(timeout);
      }

      if (!pageResponse.ok) {
        const blocked =
          pageResponse.status === 403 || pageResponse.status === 429;
        throw new Error(
          blocked
            ? `Is store ne automated access block kar diya hai (status ${pageResponse.status}). Is platform ke liye screenshot method use karein.`
            : `Product page khul nahi paayi (status ${pageResponse.status}). Link check karein.`
        );
      }

      const html = (await pageResponse.text()).slice(0, 3000000);

      if (html.trim().length < 2000) {
        throw new Error(
          "Ye page bot-protected ya client-side rendered hai (khali response aaya). Is platform ke liye screenshot method use karein."
        );
      }
      const pageImages = [
        ...new Set([
          ...extractProductImagesFromHtml(html, url),
          ...(await extractFirstCryGalleryImages(html, url)),
        ]),
      ];

      // Pull page title / meta description as extra context for the AI
      const titleMatch = html.match(
        /<title[^>]*>([^<]+)<\/title>/i
      );
      const descMatch = html.match(
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i
      );

      // Try to grab the price from HTML / JSON-LD so AI doesn't return 0.
      let priceHint = "";
      const pricePatterns = [
        /"offers":\s*{[^}]*"price":\s*"?([0-9,.]+)"?/i,
        /"priceToPay":\s*{\s*"price":\s*([0-9.]+)/i,
        /"priceAmount":\s*"?([0-9,.]+)"?/i,
      ];
      for (const pattern of pricePatterns) {
        const match = html.match(pattern);
        if (match?.[1]) {
          const value = String(match[1]).replace(/,/g, "");
          if (Number(value) > 0) {
            priceHint = `Price: Rs ${value}`;
            break;
          }
        }
      }

      const contextText = [
        titleMatch?.[1],
        descMatch?.[1],
        priceHint,
      ]
        .filter(Boolean)
        .map((s) => s.trim())
        .filter((s) => s.length > 3)
        .join("\n")
        .slice(0, 1000);

      if (pageImages.length === 0) {
        return res.status(400).json({
          success: false,
          message:
            "Is link se product image nahi mili (ye platform images JS se load karta hai). Is product ke liye screenshot option use karein.",
        });
      }

      // Download the main product image and run the same vision extraction
      const mainImage = pageImages[0];
      const imageController = new AbortController();
      const imageTimeout = setTimeout(
        () => imageController.abort(),
        30000
      );

      let imageResponse;

      try {
        imageResponse = await fetch(mainImage, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          },
          signal: imageController.signal,
        });
      } catch {
        throw new Error("Product image download nahi ho payi — screenshot try karein");
      } finally {
        clearTimeout(imageTimeout);
      }

      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      const mimeType =
        imageResponse.headers.get("content-type") || "image/jpeg";

      const info = await extractProductFromScreenshot(
        imageBuffer,
        mimeType,
        contextText
      );

      // Upload the extracted product photos to Cloudinary so the storefront
      // can use them directly. The main image is guaranteed to be a real
      // photo (the vision model just used it), so it is always uploaded even
      // when the stricter size/content-type checks would reject it.
      const uploadedImages = [];

      const pushUploaded = (url) => {
        if (url && !uploadedImages.includes(url)) {
          uploadedImages.push(url);
        }
      };

      const looksLikeImageUrl = (type, url) =>
        /^image\//i.test(type) ||
        (/\/(jpe?g|png|webp|gif)$/i.test(url) &&
          (type === "" || /^(image\/|application\/octet-stream)/i.test(type)));

      if (imageBuffer.length > 5000 && looksLikeImageUrl(mimeType, mainImage)) {
        try {
          pushUploaded(await uploadBufferToCloudinary(imageBuffer));
        } catch (error) {
          console.error(
            "Main image Cloudinary upload failed:",
            error.message
          );
        }
      }

      for (const imgUrl of pageImages.slice(0, 5)) {
        if (imgUrl === mainImage) continue;

        const controller2 = new AbortController();
        const timeout2 = setTimeout(() => controller2.abort(), 20000);

        try {
          const response2 = await fetch(imgUrl, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
            },
            signal: controller2.signal,
          });

          const buffer2 = Buffer.from(await response2.arrayBuffer());
          const type2 = response2.headers.get("content-type") || "";

          if (buffer2.length > 10000 && looksLikeImageUrl(type2, imgUrl)) {
            try {
              const secureUrl = await uploadBufferToCloudinary(buffer2);
              if (secureUrl) pushUploaded(secureUrl);
            } catch (error) {
              console.error(
                "Product image Cloudinary upload failed:",
                error.message
              );
            }
          }
        } catch (error) {
          console.error("Product image download failed:", error.message);
        } finally {
          clearTimeout(timeout2);
        }
      }

      // Fallback: if nothing could be uploaded to Cloudinary (e.g. quota or
      // datacenter IP blocked by the CDN), still hand back the original CDN
      // image URLs so the admin can review and save them.
      const images =
        uploadedImages.length > 0
          ? uploadedImages
          : pageImages.slice(0, 5);

      res.json({
        success: true,
        info,
        images,
      });
    } catch (error) {
      console.error("Link extraction failed:", error.message);
      res.status(500).json({
        success: false,
        message: error.message || "Could not extract from link",
      });
    }
  }
);

app.post(
  "/api/upload",
  requireAdmin,
  upload.array("images", 10),
  async (req, res) => {
    try {
      if (
        !process.env.CLOUDINARY_CLOUD_NAME ||
        !process.env.CLOUDINARY_API_KEY ||
        !process.env.CLOUDINARY_API_SECRET
      ) {
        return res.status(500).json({
          success: false,
          message:
            "Cloudinary is not configured on this server. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET to the server environment (Render dashboard > Environment), then restart.",
        });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          success: false,
          message: "No images selected",
        });
      }

     const uploadedImages = [];

for (const file of req.files) {
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "dealroot-products",
        transformation: [
          {
            width: 800,
            height: 800,
            crop: "fill",
            gravity: "auto",
            quality: "auto",
            fetch_format: "auto",
          },
        ],
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    stream.end(file.buffer);
  });

  uploadedImages.push(result.secure_url);
}

      res.json({
        success: true,
        images: uploadedImages,
      });
    } catch (err) {
  console.error("UPLOAD ERROR:", err);

  res.status(500).json({
    success: false,
    message: err.message,
  });
}
  }
);

// ===========================
// BANNER APIS
// ===========================

// Create Banner
app.post("/api/banners", requireAdmin, async (req, res) => {
  try {
    const {
      title,
      subtitle,
      couponCode,
      buttonText,
      buttonLink,
      image,
      active,
    } = req.body;

    const banner = await Banner.create({
      title: title || "Offer Banner",
      subtitle,
      couponCode,
      buttonText,
      buttonLink,
      image,
      active,
    });

    res.status(201).json({
      success: true,
      banner,
      message: "Banner created successfully",
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// Get All Banners
app.get("/api/banners", async (req, res) => {
  try {
    const banners = await Banner.find().sort({
      createdAt: -1,
    });

    res.json({
      success: true,
      banners,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});
// Get Active Banner
app.get("/api/banners/active", async (req, res) => {
  try {
    const banners = await Banner.find({
      active: true,
    }).sort({
      createdAt: -1,
    });

    res.json({
      success: true,
      banners,
      // Backward-compatible: single banner = first active one
      banner: banners[0] || null,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// Update Banner
app.put("/api/banners/:id", requireAdmin, async (req, res) => {
  try {
    const banner = await Banner.findByIdAndUpdate(
      req.params.id,
      req.body,
      {
        new: true,
        runValidators: true,
      }
    );

    if (!banner) {
      return res.status(404).json({
        success: false,
        message: "Banner not found",
      });
    }

    res.json({
      success: true,
      message: "Banner updated successfully",
      banner,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// Delete Banner
app.delete("/api/banners/:id", requireAdmin, async (req, res) => {
  try {
    const banner = await Banner.findByIdAndDelete(req.params.id);

    if (!banner) {
      return res.status(404).json({
        success: false,
        message: "Banner not found",
      });
    }

    res.json({
      success: true,
      message: "Banner deleted successfully",
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});


app.post("/api/coupons", requireAdmin, async (req, res) => {
  try {
    const {
      code,
      discountType,
      discountValue,
      minimumOrder,
      maximumDiscount,
      expiryDate,
    } = req.body;

    if (!code || !discountValue) {
      return res.status(400).json({
        success: false,
        message: "Coupon code and discount are required",
      });
    }

    const exists = await Coupon.findOne({
      code: code.toUpperCase(),
    });

    if (exists) {
      return res.status(400).json({
        success: false,
        message: "Coupon already exists",
      });
    }

    const coupon = await Coupon.create({
      code: code.toUpperCase(),
      discountType,
      discountValue,
      minimumOrder,
      maximumDiscount,
      expiryDate,
    });

    res.status(201).json({
      success: true,
      message: "Coupon created successfully",
      coupon,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

app.get("/api/coupons", async (req, res) => {
  const coupons = await Coupon.find().sort({
    createdAt: -1,
  });

  res.json({
    success: true,
    coupons,
  });
});

app.post("/api/coupons/apply", async (req, res) => {
  try {
    const { code, subtotal } = req.body;

    const coupon = await Coupon.findOne({
      code: code.toUpperCase(),
      active: true,
    });

    if (!coupon) {
      return res.status(400).json({
        success: false,
        message: "Invalid coupon code",
      });
    }

    if (
      coupon.expiryDate &&
      new Date(coupon.expiryDate) < new Date()
    ) {
      return res.status(400).json({
        success: false,
        message: "Coupon expired",
      });
    }

    if (subtotal < coupon.minimumOrder) {
      return res.status(400).json({
        success: false,
        message: `Minimum order ₹${coupon.minimumOrder}`,
      });
    }

    let discount = 0;

    if (coupon.discountType === "percentage") {
      discount =
        subtotal * coupon.discountValue / 100;

      if (
        coupon.maximumDiscount &&
        discount > coupon.maximumDiscount
      ) {
        discount = coupon.maximumDiscount;
      }
    } else {
      discount = coupon.discountValue;
    }

    res.json({
      success: true,
      coupon,
      discount,
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});


app.delete("/api/coupons/:id", requireAdmin, async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);

    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: "Coupon not found",
      });
    }

    res.json({
      success: true,
      message: "Coupon deleted successfully",
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
});

app.post("/api/products", requireAdmin, async (req, res) => {
  try {
    const error = validateProduct(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: error,
      });
    }

    const product = await Product.create(productPayload(req.body));

    res.status(201).json({
      success: true,
      message: "Product added successfully",
      product,
    });
  } catch {
    res.status(500).json({
      success: false,
      message: "Could not add product",
    });
  }
});

app.put("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const error = validateProduct(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: error,
      });
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      productPayload(req.body),
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.json({
      success: true,
      message: "Product updated successfully",
      product,
    });
  } catch {
    res.status(400).json({
      success: false,
      message: "Could not update product",
    });
  }
});

app.patch("/api/products/:id/stock", requireAdmin, async (req, res) => {
  try {
    const stock = Number(req.body.stock);

    if (!Number.isInteger(stock) || stock < 0) {
      return res.status(400).json({
        success: false,
        message: "Stock must be a whole positive number",
      });
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { stock },
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.json({
      success: true,
      message: "Stock updated successfully",
      product,
    });
  } catch {
    res.status(400).json({
      success: false,
      message: "Could not update stock",
    });
  }
});

// Admin: toggle a product in the Dealroot Tryouts program.
app.patch("/api/products/:id/tryout", requireAdmin, async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { tryoutOnly: Boolean(req.body?.tryoutOnly) },
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    res.json({
      success: true,
      message: product.tryoutOnly
        ? "Product added to Dealroot Tryouts" 
        : "Product removed from Dealroot Tryouts",
      product,
    });
  } catch {
    res.status(400).json({ success: false, message: "Could not update tryout status" });
  }
});

app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.json({
      success: true,
      message: "Product deleted successfully",
    });
  } catch {
    res.status(400).json({
      success: false,
      message: "Could not delete product",
    });
  }
});

app.post(
  "/api/payments/razorpay/create-order",
  paymentLimiter,
  optionalUser,
  async (req, res) => {
    try {
      const instance = getRazorpay();
      const quote = await buildOnlinePaymentQuote({
  ...req.body,
  paymentMethod: req.body.paymentMethod,
  userId: req.user?.userId || null,
});
      const orderNumber = createOrderNumber();

      const razorpayOrder = await instance.orders.create({
        amount: quote.amountInPaise,
        currency: "INR",
        receipt: orderNumber,
        notes: {
          dealroot_order_number: orderNumber,
        },
      });

      const paymentSession = await PaymentSession.create({
        user: req.user?.userId || null,
        orderNumber,
        customer: quote.cleanCustomer,
        items: quote.orderItems,
        deliveryFee: quote.deliveryFee,
        couponCode: quote.couponCode,
        discountAmount: quote.discountAmount,
        totalAmount: quote.totalAmount,
        payableNow: quote.payableNow,
codAmount: quote.codAmount,
paymentMethod: req.body.paymentMethod || "razorpay",
        amountInPaise: quote.amountInPaise,
        deliveryType: quote.deliveryType,
        tryoutOrder: quote.tryoutOrder || false,
        razorpayOrderId: razorpayOrder.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      if (req.user?.userId) {
        await User.findByIdAndUpdate(
          req.user.userId,
          { $set: quote.cleanCustomer },
          { runValidators: true }
        );
      }

      res.status(201).json({
        success: true,
        keyId: razorpayKeyId,
        paymentSessionId: paymentSession._id,
        razorpayOrderId: razorpayOrder.id,
        orderNumber,
        amount: quote.amountInPaise,
        currency: "INR",
      });
    } catch (error) {
      console.error(
        "Razorpay order creation failed:",
        error.error?.description || error.message
      );

      res.status(error.statusCode || 400).json({
        success: false,
        message:
          error.error?.description ||
          error.message ||
          "Could not start online payment",
      });
    }
  }
);

app.post(
  "/api/payments/razorpay/verify",
  paymentLimiter,
  optionalUser,
  async (req, res) => {
    try {
      getRazorpay();

      const paymentSessionId = String(
        req.body?.paymentSessionId || ""
      );
      const razorpayOrderId = String(
        req.body?.razorpayOrderId || ""
      );
      const razorpayPaymentId = String(
        req.body?.razorpayPaymentId || ""
      );
      const razorpaySignature = String(
        req.body?.razorpaySignature || ""
      );

      if (
        !mongoose.Types.ObjectId.isValid(paymentSessionId) ||
        !razorpayOrderId ||
        !razorpayPaymentId ||
        !razorpaySignature
      ) {
        throw new Error("Incomplete payment verification details");
      }

      const paymentSessionRecord = await PaymentSession.findOne({
        _id: paymentSessionId,
        razorpayOrderId,
      });

      if (!paymentSessionRecord) {
        const error = new Error("Payment session not found");
        error.statusCode = 404;
        throw error;
      }

      const expectedSignature = crypto
        .createHmac("sha256", razorpayKeySecret)
        .update(
          `${paymentSessionRecord.razorpayOrderId}|${razorpayPaymentId}`
        )
        .digest("hex");

      if (!signaturesMatch(razorpaySignature, expectedSignature)) {
        const error = new Error("Payment signature verification failed");
        error.statusCode = 400;
        throw error;
      }

      const payment = await getCapturedRazorpayPayment({
        razorpayOrderId: paymentSessionRecord.razorpayOrderId,
        razorpayPaymentId,
        amountInPaise: paymentSessionRecord.amountInPaise,
      });

      const order = await finaliseRazorpayPayment({
        paymentSessionRecord,
        payment,
        razorpaySignature,
      });

      res.status(201).json({
        success: true,
        message: "Payment verified and order confirmed",
        order,
      });
    } catch (error) {
      console.error(
        "Razorpay verification failed:",
        error.error?.description || error.message
      );

      res.status(error.statusCode || 400).json({
        success: false,
        message:
          error.error?.description ||
          error.message ||
          "Could not verify payment",
      });
    }
  }
);

app.post("/api/payments/razorpay/webhook", async (req, res) => {
  try {
    if (!razorpayWebhookSecret) {
      return res.status(503).json({
        success: false,
        message: "Razorpay webhook is not configured",
      });
    }

    if (!Buffer.isBuffer(req.body)) {
      return res.status(400).json({
        success: false,
        message: "Webhook body must be raw",
      });
    }

    const receivedSignature = String(
      req.headers["x-razorpay-signature"] || ""
    );
    const expectedSignature = crypto
      .createHmac("sha256", razorpayWebhookSecret)
      .update(req.body)
      .digest("hex");

    if (!signaturesMatch(receivedSignature, expectedSignature)) {
      return res.status(400).json({
        success: false,
        message: "Invalid webhook signature",
      });
    }

    const event = JSON.parse(req.body.toString("utf8"));

    if (event.event !== "payment.captured") {
      return res.json({ success: true, ignored: true });
    }

    const paymentEntity = event.payload?.payment?.entity;

    if (!paymentEntity?.id || !paymentEntity?.order_id) {
      return res.json({ success: true, ignored: true });
    }

    const paymentSessionRecord = await PaymentSession.findOne({
      razorpayOrderId: paymentEntity.order_id,
    });

    if (!paymentSessionRecord) {
      return res.json({ success: true, ignored: true });
    }

    const payment = await getCapturedRazorpayPayment({
      razorpayOrderId: paymentSessionRecord.razorpayOrderId,
      razorpayPaymentId: paymentEntity.id,
      amountInPaise: paymentSessionRecord.amountInPaise,
    });

    await finaliseRazorpayPayment({
      paymentSessionRecord,
      payment,
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Razorpay webhook failed:", error.message);

    if (
      ["PAYMENT_REFUNDED", "PAYMENT_REVIEW_REQUIRED"].includes(
        error.code
      )
    ) {
      return res.json({ success: true, handled: true });
    }

    res.status(500).json({
      success: false,
      message: "Webhook processing failed",
    });
  }
});

app.post("/api/orders", requireUser, async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { customer, items, paymentMethod, couponCode } = req.body;
    const normalizedCoupon = String(couponCode || "")
      .trim()
      .toUpperCase();

   const cleanCustomer = {
  name: String(customer?.name || "").trim(),
  email: String(customer?.email || req.user?.email || "").trim().toLowerCase(),
  phone: String(customer?.phone || "").replace(/\D/g, ""),
  state: String(customer?.state || "").trim(),
  address: String(customer?.address || "").trim(),
  city: String(customer?.city || "").trim(),
  pincode: String(customer?.pincode || "").replace(/\D/g, ""),
};

    if (
      !cleanCustomer.name ||
      !cleanCustomer.address ||
      !cleanCustomer.city ||
      cleanCustomer.phone.length !== 10 ||
      cleanCustomer.pincode.length !== 6
    ) {
      throw new Error("Please enter valid delivery details");
    }

    if (!Array.isArray(items) || !items.length) {
      throw new Error("Your cart is empty");
    }

    if (paymentMethod && paymentMethod !== "cod") {
      throw new Error(
        "Online payment is not available yet. Please choose Cash on Delivery."
      );
    }

    let couponRecord = null;

    if (normalizedCoupon) {
      couponRecord = await Coupon.findOne({
        code: normalizedCoupon,
        active: true,
      });

      if (!couponRecord) {
        throw new Error("Invalid coupon code");
      }

      if (
        couponRecord.expiryDate &&
        new Date(couponRecord.expiryDate) < new Date()
      ) {
        throw new Error("Coupon expired");
      }
    }

    let order;

    await session.withTransaction(async () => {
      const orderItems = [];
      let subtotal = 0;
      let hasTryoutItem = false;

      for (const item of items) {
        const productId = item?.productId;
        const quantity = Number(item?.quantity);

        if (
          !mongoose.Types.ObjectId.isValid(productId) ||
          !Number.isInteger(quantity) ||
          quantity < 1
        ) {
          throw new Error("Invalid product or quantity in cart");
        }

        const product = await Product.findOneAndUpdate(
          {
            _id: productId,
            stock: { $gte: quantity },
          },
          { $inc: { stock: -quantity } },
          { new: true, session }
        );

        if (!product) {
          throw new Error(
            "A product is unavailable or does not have enough stock"
          );
        }

        if (product.tryoutOnly) {
          hasTryoutItem = true;

          const tryoutMember = await TryoutApplication.findOne({
            user: req.user.userId,
            status: "approved",
          });
          if (!tryoutMember) {
            throw new Error(
              "This product is exclusive to approved Tryout members. Kindly apply for the Tryout program first."
            );
          }
        }

        const lineTotal = product.price * quantity;
        subtotal += lineTotal;

        orderItems.push({
          product: product._id,
          brand: product.brand,
          title: product.title,
          images: product.images || [],
          price: product.price,
          quantity,
          subtotal: lineTotal,
        });
      }

      const normalizedCity = cleanCustomer.city
        .toLowerCase()
        .replace(/\s+/g, " ");
      const isKanpurAddress = normalizedCity.includes("kanpur");
      const deliveryFee =
        subtotal >= 499 ? 0 : isKanpurAddress ? 29 : 49;
      let discountAmount = 0;

      if (couponRecord) {
        if (subtotal < couponRecord.minimumOrder) {
          throw new Error(
            "Minimum order ₹" + couponRecord.minimumOrder + " for this coupon"
          );
        }

        if (couponRecord.discountType === "percentage") {
          discountAmount = Math.round(
            (subtotal * couponRecord.discountValue) / 100
          );

          if (
            couponRecord.maximumDiscount &&
            discountAmount > couponRecord.maximumDiscount
          ) {
            discountAmount = couponRecord.maximumDiscount;
          }
        } else {
          discountAmount = Math.min(
            couponRecord.discountValue,
            subtotal
          );
        }
      }

      [order] = await Order.create(
        [
          {
            orderNumber: createOrderNumber(),
            user: req.user?.userId || null,
            customer: cleanCustomer,
            items: orderItems,
            deliveryFee,
            couponCode: normalizedCoupon,
            discountAmount,
            totalAmount: subtotal - discountAmount + deliveryFee,
            deliveryType: isKanpurAddress ? "local" : "courier",
            paymentMethod: "cod",
            tryoutOrder: hasTryoutItem,
          },
        ],
        { session }
      );

      if (req.user?.userId) {
        await User.findByIdAndUpdate(
          req.user.userId,
          { $set: cleanCustomer },
          { session, runValidators: true }
        );
      }
    });

    if (order) {
      // Notify customer + owner without blocking the order response.
      sendOrderEmails(order).catch((error) =>
        console.error("Order email failed:", error.message)
      );
    }

    res.status(201).json({
      success: true,
      message: "Your order has been placed successfully",
      order,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Could not place your order",
    });
  } finally {
    await session.endSession();
  }
});

app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });

    res.json({
      success: true,
      count: orders.length,
      orders,
    });
  } catch {
    res.status(500).json({
      success: false,
      message: "Could not load orders",
    });
  }
});

const orderStatusLabels = {
  placed: "Order Placed",
  confirmed: "Order Confirmed",
  packed: "Order Packed",
  shipped: "Order Shipped",
  delivered: "Order Delivered",
  cancelled: "Order Cancelled",
};

const orderStatusEmojis = {
  placed: "📦",
  confirmed: "✅",
  packed: "🧳",
  shipped: "🚚",
  delivered: "🏠",
  cancelled: "❌",
};

// Notify the customer by email whenever their order status changes.
async function sendOrderStatusEmail(order) {
  if (!order) return;

  const customerEmail =
    String(order.customer?.email || "").trim() ||
    (order.user
      ? (await User.findOne({ _id: order.user }).select("email"))?.email
      : "") ||
    "";

  if (!customerEmail) return;

  if (process.env.ORDER_STATUS_EMAIL_DRY_RUN === "true") {
    console.log(
      "[dry-run] Status email " + order.orderNumber + " → " + order.orderStatus
    );
    return;
  }

  const label = orderStatusLabels[order.orderStatus] || order.orderStatus;
  const emoji = orderStatusEmojis[order.orderStatus] || "📦";
  const siteUrl = seoSiteUrl;
  const trackUrl = siteUrl + "/account";

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#fff;">\n' +
    '  <div style="background:#e21c48;padding:22px 28px;text-align:center;">\n' +
    '    <h1 style="color:#fff;margin:0;font-size:20px;">DEALROOT BEAUTY</h1>\n' +
    '    <p style="color:#ffe4e9;margin:6px 0 0;font-size:13px;">Your order is on the move 🛍️</p>\n' +
    "  </div>\n" +
    '  <div style="padding:28px;">\n' +
    '    <p style="font-size:14px;color:#333;">Hi ' +
    xmlEscape(order.customer?.name || "there") +
    ",</p>\n" +
    '    <div style="background:#fff5f7;border:1px solid #ffd6de;border-radius:10px;padding:16px 20px;margin:18px 0;text-align:center;">\n' +
    '      <span style="font-size:44px;line-height:1;">' +
    emoji +
    "</span>\n" +
    '      <h2 style="margin:8px 0 4px;font-size:20px;color:#e21c48;">' +
    label +
    "</h2>\n" +
    '      <span style="font-size:12px;color:#999;">Order ' +
    order.orderNumber +
    "</span>\n" +
    "    </div>\n" +
    '    <p style="font-size:14px;color:#555;line-height:1.6;">' +
    (order.orderStatus === "delivered"
      ? "Your order has been delivered. We hope you love it! A gentle reminder — you can review your products anytime."
      : order.orderStatus === "shipped"
      ? "Great news — your order is out for delivery and will reach you soon."
      : "We're updating you on the progress of your order.") +
    "</p>\n" +
    '    <a href="' +
    trackUrl +
    '" style="display:block;text-align:center;background:#e21c48;color:#fff;text-decoration:none;padding:14px;border-radius:999px;font-size:14px;font-weight:700;">Track your order</a>\n' +
    '    <p style="font-size:12px;color:#999;margin-top:20px;line-height:1.6;text-align:center;">Questions? Reach us at dealroot.store@gmail.com or @Tom_andrew72 on Telegram.</p>\n' +
    "  </div>\n" +
    "</div>";

  await transporter.sendMail({
    from: '"DEALROOT Beauty" <' + process.env.EMAIL_USER + ">",
    to: customerEmail,
    subject: emoji + " " + label + " — " + order.orderNumber,
    html,
  });
}

app.patch("/api/orders/:id/status", requireAdmin, async (req, res) => {
  try {
    const { orderStatus } = req.body;

    if (!orderStatuses.includes(orderStatus)) {
      return res.status(400).json({
        success: false,
        message: "Please choose a valid order status",
      });
    }

    if (orderStatus === "cancelled") {
      return res.status(400).json({
        success: false,
        message: "Use the cancel order action instead",
      });
    }

    const previous = await Order.findById(req.params.id);

    if (!previous) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      {
        orderStatus,
        $push: {
          statusHistory: { status: orderStatus, at: new Date() },
        },
      },
      { new: true, runValidators: true }
    );

    if (orderStatus !== previous.orderStatus) {
      sendOrderStatusEmail(order).catch((error) =>
        console.error("Order status email failed:", error.message)
      );
    }

    res.json({
      success: true,
      message:
        orderStatus !== previous.orderStatus
          ? "Order marked as " +
            orderStatus +
            " — customer notified by email"
          : "Order status is already " + orderStatus,
      order,
    });
  } catch {
    res.status(400).json({
      success: false,
      message: "Could not update order status",
    });
  }
});

app.post("/api/orders/:id/cancel", requireAdmin, async (req, res) => {
  const session = await mongoose.startSession();

  try {
    let order;

    await session.withTransaction(async () => {
      order = await Order.findOne({ _id: req.params.id }).session(session);

      if (!order) {
        throw new Error("Order not found");
      }

      if (order.orderStatus === "cancelled") {
        throw new Error("This order has already been cancelled");
      }

      if (["shipped", "delivered"].includes(order.orderStatus)) {
        throw new Error(
          "A shipped or delivered order cannot be cancelled from admin"
        );
      }

      for (const item of order.items) {
        await Product.findByIdAndUpdate(
          item.product,
          { $inc: { stock: item.quantity } },
          { session }
        );
      }

      order.orderStatus = "cancelled";
      order.stockRestored = true;
      order.cancelledAt = new Date();
      order.statusHistory.push({ status: "cancelled", at: new Date() });

if (!order.customer.state) {
  order.customer.state = "Uttar Pradesh";
}

      await order.save({
  session,
  validateBeforeSave: false,
});
    });

    sendOrderStatusEmail(order).catch((error) =>
      console.error("Cancellation email failed:", error.message)
    );

    res.json({
      success: true,
      message: "Order cancelled and stock restored",
      order,
    });
} catch (error) {
  console.log("=================================");
  console.log("CANCEL ORDER ERROR");
  console.log(error);
  console.log(error.message);
  console.log("=================================");

  res.status(400).json({
    success: false,
    message: error.message || "Could not cancel order",
  });
} finally {
    await session.endSession();
  }
});

const updateProductRating = async (productId) => {
  const reviews = await Review.find({ product: productId });

  const totalReviews = reviews.length;

  const averageRating =
    totalReviews === 0
      ? 0
      : reviews.reduce((sum, review) => sum + review.rating, 0) /
        totalReviews;

  await Product.findByIdAndUpdate(productId, {
    rating: Number(averageRating.toFixed(1)),
    reviews: totalReviews,
  });
};


// ===========================
// ABANDONED CART RECOVERY
// ===========================
const abandonedCartSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    email: { type: String, default: "", lowercase: true, trim: true },
    name: { type: String, default: "" },
    items: [
      {
        product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
        title: { type: String, default: "" },
        brand: { type: String, default: "" },
        price: { type: Number, default: 0 },
        image: { type: String, default: "" },
        quantity: { type: Number, default: 1 },
        subtotal: { type: Number, default: 0 },
      },
    ],
    subtotal: { type: Number, default: 0 },
    couponCode: { type: String, default: "" },
    couponId: { type: mongoose.Schema.Types.ObjectId, ref: "Coupon", default: null },
    status: { type: String, enum: ["pending", "processing", "emailed"], default: "pending" },
    lastSeenAt: { type: Date, default: Date.now },
    emailSentAt: { type: Date, default: null },
  },
  { timestamps: true }
);
const AbandonedCart = mongoose.model("AbandonedCart", abandonedCartSchema);

// Config (override via env on Render/local)
const cartRecoveryHours = Number(process.env.CART_RECOVERY_HOURS || 1);
const cartRecoveryDiscount = Number(process.env.CART_RECOVERY_DISCOUNT || 10);
const cartRecoveryMinOrder = Number(process.env.CART_RECOVERY_MIN_ORDER || 499);
const cartRecoveryMaxDiscount = Number(process.env.CART_RECOVERY_MAX_DISCOUNT || 150);
const cartRecoveryValidHours = Number(process.env.CART_RECOVERY_VALID_HOURS || 72);


// Save a logged-in user's cart snapshot so we can recover it later. Sending an
// empty items array (or an empty cart after checkout) clears the snapshot.
app.post("/api/cart/save", requireUser, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "Account not found" });
    }

    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];

    if (rawItems.length === 0) {
      await AbandonedCart.deleteOne({ user: user._id });
      return res.json({ success: true, message: "Cart cleared" });
    }

    // Normalise against the real catalogue (server-side prices, never trust
    // the client for price/title).
    const items = [];
    let subtotal = 0;

    for (const item of rawItems.slice(0, 50)) {
      const productId = String(item?.productId || "");
      if (!mongoose.Types.ObjectId.isValid(productId)) continue;

      const product = await Product.findById(productId);
      if (!product) continue;

      const quantity = Math.max(1, Math.min(Number(item.quantity) || 1, 99));
      const lineTotal = Math.round(product.price * quantity * 100) / 100;
      subtotal += lineTotal;

      items.push({
        product: product._id,
        title: product.title,
        brand: product.brand,
        price: product.price,
        image: product.images?.[0] || "",
        quantity,
        subtotal: lineTotal,
      });
    }

    if (items.length === 0) {
      return res.json({ success: true, message: "Nothing to save" });
    }

    const existing = await AbandonedCart.findOne({ user: user._id });

    await AbandonedCart.findOneAndUpdate(
      { user: user._id },
      {
        $set: {
          email: user.email,
          name: user.name,
          items,
          subtotal: Math.round(subtotal * 100) / 100,
          lastSeenAt: new Date(),
          // Never re-email within the same abandoned episode.
          status: existing?.status === "emailed" ? "emailed" : "pending",
        },
      },
      { upsert: true, returnDocument: "after" }
    );

    res.json({ success: true, message: "Cart saved" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Admin: list recent abandoned carts.
app.get("/api/admin/cart-recovery", requireAdmin, async (req, res) => {
  try {
    const carts = await AbandonedCart.find()
      .sort({ lastSeenAt: -1 })
      .limit(25);
    res.json({ success: true, carts });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Creates a unique discount coupon for one abandoned cart. Reuses the real
// Coupon collection so checkout applies it like any admin-created coupon.
async function createRecoveryCoupon() {
  let code = "";

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate =
      "CART" +
      cartRecoveryDiscount +
      "-" +
      crypto.randomBytes(3).toString("hex").toUpperCase();

    const exists = await Coupon.findOne({ code: candidate });
    if (!exists) {
      code = candidate;
      break;
    }
  }

  if (!code) return null;

  return Coupon.create({
    code,
    discountType: "percentage",
    discountValue: cartRecoveryDiscount,
    minimumOrder: cartRecoveryMinOrder,
    maximumDiscount: cartRecoveryMaxDiscount,
    expiryDate: new Date(Date.now() + cartRecoveryValidHours * 3600 * 1000),
    active: true,
  });
}

async function sendAbandonedCartEmail(cart, coupon) {
  const siteUrl = seoSiteUrl;
  if (process.env.CART_RECOVERY_DRY_RUN === "true") {
    console.log("[dry-run] Would email " + cart.email + " with coupon " + coupon.code);
    return;
  }

  const itemsHtml = (cart.items || [])
    .map(
      (item) =>
        "      <tr>\n" +
        '        <td style="padding:12px;border-bottom:1px solid #eee;">\n' +
        "          <table><tr>\n" +
        '            <td style="padding-right:14px;">' +
        (item.image
          ? '<img src="' + item.image + '" width="60" height="76" style="border-radius:8px;object-fit:cover;" alt="" />'
          : "") +
        "</td>\n" +
        '            <td style="vertical-align:middle;">\n' +
        '              <strong style="font-size:13px;color:#333;display:block;">' +
        xmlEscape(item.title) +
        "</strong>\n" +
        '              <span style="color:#999;font-size:12px;">' +
        xmlEscape(item.brand || "") +
        " &bull; Qty: " +
        item.quantity +
        "</span>\n" +
        "            </td>\n" +
        "          </tr></table>\n" +
        "        </td>\n" +
        '        <td style="padding:12px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;font-size:14px;color:#333;font-weight:600;">₹' +
        item.price +
        "</td>\n" +
        "      </tr>"
    )
    .join("\n");

  const subject =
    "Your DEALROOT cart is waiting — " + cartRecoveryDiscount + "% off!";

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#fff;">\n' +
    '  <div style="background:#e21c48;padding:22px 28px;text-align:center;">\n' +
    '    <h1 style="color:#fff;margin:0;font-size:20px;">DEALROOT BEAUTY</h1>\n' +
    '    <p style="color:#ffe4e9;margin:6px 0 0;font-size:13px;">You left something beautiful behind 💄</p>\n' +
    "  </div>\n" +
    '  <div style="padding:28px;">\n' +
    '    <p style="font-size:14px;color:#333;">Hi ' +
    xmlEscape(cart.name || "there") +
    ",</p>\n" +
    '    <p style="font-size:14px;color:#555;line-height:1.6;">Your cart is still saved and waiting for you. Complete your order in the next few days and enjoy <strong style="color:#e21c48;">' +
    cartRecoveryDiscount +
    "% off</strong> — it's our little nudge to treat yourself.</p>\n" +
    '    <div style="background:#fff5f7;border:1px solid #ffd6de;border-radius:10px;padding:16px 20px;margin:18px 0;text-align:center;">\n' +
    '      <span style="font-size:12px;color:#999;display:block;margin-bottom:6px;">USE THIS CODE AT CHECKOUT</span>\n' +
    '      <span style="font-size:26px;font-weight:800;color:#e21c48;letter-spacing:3px;">' +
    coupon.code +
    "</span>\n" +
    '      <span style="font-size:12px;color:#999;display:block;margin-top:8px;">' +
    cartRecoveryDiscount +
    "% off up to ₹" +
    cartRecoveryMaxDiscount +
    " &bull; Min. order ₹" +
    cartRecoveryMinOrder +
    " &bull; Valid " +
    cartRecoveryValidHours +
    " hours</span>\n" +
    "    </div>\n" +
    '    <a href="' +
    siteUrl +
    '" style="display:block;text-align:center;background:#e21c48;color:#fff;text-decoration:none;padding:14px;border-radius:999px;font-size:14px;font-weight:700;">Return to your cart</a>\n' +
    '    <p style="font-size:12px;color:#999;margin-top:20px;line-height:1.6;text-align:center;">Questions? Reach us at dealroot.store@gmail.com or @Tom_andrew72 on Telegram.</p>\n' +
    "  </div>\n" +
    "</div>";

  await transporter.sendMail({
    from: '"DEALROOT Beauty" <' + process.env.EMAIL_USER + ">",
    to: cart.email,
    subject,
    html,
  });
}

async function runCartRecoveryScan() {
  try {
    const cutoff = new Date(Date.now() - cartRecoveryHours * 3600 * 1000);

    const candidates = await AbandonedCart.find({
      status: "pending",
      email: { $ne: "" },
      lastSeenAt: { $lte: cutoff },
    })
      .select("_id")
      .limit(20);

    for (const candidate of candidates) {
      // Atomically claim the cart so a concurrent scheduler (or a restart
      // mid-scan) can never email the same cart twice.
      const cart = await AbandonedCart.findOneAndUpdate(
        { _id: candidate._id, status: "pending" },
        { $set: { status: "processing" } },
        { returnDocument: "after" }
      );

      if (!cart) continue;

      try {
        const coupon = await createRecoveryCoupon();

        if (!coupon) {
          await AbandonedCart.updateOne(
            { _id: cart._id },
            { $set: { status: "pending" } }
          );
          continue;
        }

        await sendAbandonedCartEmail(cart, coupon);

        cart.couponCode = coupon.code;
        cart.couponId = coupon._id;
        cart.status = "emailed";
        cart.emailSentAt = new Date();
        await cart.save();

        console.log(
          "Cart recovery email sent to " + cart.email + " (" + coupon.code + ")"
        );
      } catch (error) {
        console.error(
          "Cart recovery failed for " + cart.email + ":", error.message
        );
        // Transient failure (e.g. SMTP down) — allow a retry next scan.
        await AbandonedCart.updateOne(
          { _id: cart._id },
          { $set: { status: "pending" } }
        );
      }
    }

    return candidates.length;
  } catch (error) {
    console.error("Cart recovery scan error:", error.message);
    return 0;
  }
}

// Run the scan on demand (admin button / curl).
app.post("/api/admin/cart-recovery/run", requireAdmin, async (req, res) => {
  try {
    const sent = await runCartRecoveryScan();
    res.json({
      success: true,
      message: "Recovery scan complete — " + sent + " email(s) sent",
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Scheduled scan: on startup + every 15 minutes.
function startCartRecoveryScheduler() {
  runCartRecoveryScan().catch(() => {});
  setInterval(() => {
    runCartRecoveryScan().catch(() => {});
  }, 15 * 60 * 1000);
  console.log("Abandoned cart recovery scheduler started (every 15 min)");
}

// ===================== RETURNS & REFUNDS =====================
const RETURN_REASONS = [
  "Product is defective / not working",
  "Item arrived damaged or broken",
  "Wrong item was delivered",
  "Product quality not as expected",
  "Missing parts / accessories",
  "Change of mind (no longer needed)",
];

const returnRequestSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    orderNumber: { type: String, required: true, index: true },
    items: [
      {
        product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
        title: { type: String, default: "" },
        quantity: { type: Number, default: 1 },
        price: { type: Number, default: 0 },
      },
    ],
    reason: { type: String, required: true },
    description: { type: String, default: "" },
    images: { type: [String], default: [] },
    video: { type: String, default: "" },
    upiId: { type: String, default: "" },
    expectedAmount: { type: Number, default: 0 },
    shippingFee: { type: Number, default: 0 },
    refundableAmount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },
    deductionAmount: { type: Number, default: 0 },
    refundAmount: { type: Number, default: 0 },
    adminNote: { type: String, default: "" },
    rejectionReason: { type: String, default: "" },
    requestedAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const ReturnRequest = mongoose.model("ReturnRequest", returnRequestSchema);

// Upload a return file (image or video) to Cloudinary without the 800x800
// image crop used for product photos.
const uploadReturnFile = (buffer, isVideo) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "dealroot-returns",
        resource_type: isVideo ? "video" : "image",
        ...(isVideo
          ? {}
          : { transformation: [{ quality: "auto", fetch_format: "auto" }] }),
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });

async function sendRefundAppliedEmail(returnRequest, order, customerEmail) {
  if (process.env.ORDER_STATUS_EMAIL_DRY_RUN === "true") {
    console.log("[dry-run] Refund applied email → " + order.orderNumber);
    return;
  }

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#fff;">\n' +
    '  <div style="background:#e21c48;padding:22px 28px;text-align:center;">\n' +
    '    <h1 style="color:#fff;margin:0;font-size:20px;">DEALROOT BEAUTY</h1>\n' +
    '    <p style="color:#ffe4e9;margin:6px 0 0;font-size:13px;">Return / Refund request received</p>\n' +
    "  </div>\n" +
    '  <div style="padding:28px;">\n' +
    '    <p style="font-size:14px;color:#333;">Hi ' +
    xmlEscape(order.customer?.name || "there") +
    ",</p>\n" +
    '    <p style="font-size:14px;color:#555;line-height:1.6;">We have received your return request for order <strong>' +
    order.orderNumber +
    "</strong>. Our team will review it within 1-2 business days.</p>\n" +
    '    <div style="background:#fff5f7;border:1px solid #ffd6de;border-radius:10px;padding:16px 20px;margin:18px 0;">\n' +
    '      <h3 style="margin:0 0 10px;font-size:15px;color:#e21c48;">Return summary</h3>\n' +
    '      <table style="width:100%;font-size:13px;color:#444;border-collapse:collapse;">\n' +
    "        <tr><td style='padding:4px 0;'>Order number</td><td style='text-align:right;font-weight:700;'>" +
    order.orderNumber +
    "</td></tr>\n" +
    "        <tr><td style='padding:4px 0;'>Return reason</td><td style='text-align:right;'>" +
    xmlEscape(returnRequest.reason) +
    "</td></tr>\n" +
    "        <tr><td style='padding:4px 0;'>Order total</td><td style='text-align:right;'>₹" +
    Number(returnRequest.expectedAmount || 0).toFixed(2) +
    "</td></tr>\n" +
    "        <tr><td style='padding:4px 0;'>Shipping fee (non-refundable)</td><td style='text-align:right;color:#c0392b;'>- ₹" +
    Number(returnRequest.shippingFee || 0).toFixed(2) +
    "</td></tr>\n" +
    "        <tr><td style='padding:4px 0;'>Amount refundable after approval</td><td style='text-align:right;font-weight:700;'>₹" +
    Number(returnRequest.refundableAmount || 0).toFixed(2) +
    "</td></tr>\n" +
    "        <tr><td style='padding:4px 0;'>Refund method</td><td style='text-align:right;'>UPI" +
    (returnRequest.upiId ? " (" + xmlEscape(returnRequest.upiId) + ")" : "") +
    "</td></tr>\n" +
    "      </table>\n" +
    "    </div>\n" +
    '    <p style="font-size:13px;color:#777;line-height:1.6;">Once your request is approved, you will receive a confirmation email with the exact deduction (if any) and the final amount to be refunded.</p>\n' +
    '    <a href="' +
    seoSiteUrl +
    '/account" style="display:block;text-align:center;background:#e21c48;color:#fff;text-decoration:none;padding:14px;border-radius:999px;font-size:14px;font-weight:700;">Track my return</a>\n' +
    '    <p style="font-size:12px;color:#999;margin-top:20px;line-height:1.6;text-align:center;">Questions? Reach us at dealroot.store@gmail.com or @Tom_andrew72 on Telegram.</p>\n' +
    "  </div>\n" +
    "</div>";

  await transporter.sendMail({
    from: '"DEALROOT Beauty" <' + process.env.EMAIL_USER + ">",
    to: customerEmail,
    subject: "🔄 Return request received — " + order.orderNumber,
    html,
  });
}

async function sendRefundApprovedEmail(returnRequest, order, customerEmail) {
  if (process.env.ORDER_STATUS_EMAIL_DRY_RUN === "true") {
    console.log("[dry-run] Refund approved email → " + order.orderNumber);
    return;
  }

  const refund = Number(returnRequest.refundAmount || 0);
  const deduction = Number(returnRequest.deductionAmount || 0);
  const expected = Number(returnRequest.expectedAmount || 0);

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#fff;">\n' +
    '  <div style="background:#12805c;padding:22px 28px;text-align:center;">\n' +
    '    <h1 style="color:#fff;margin:0;font-size:20px;">DEALROOT BEAUTY</h1>\n' +
    '    <p style="color:#d8f5e9;margin:6px 0 0;font-size:13px;">Refund request has been accepted ✅</p>\n' +
    "  </div>\n" +
    '  <div style="padding:28px;">\n' +
    '    <p style="font-size:14px;color:#333;">Hi ' +
    xmlEscape(order.customer?.name || "there") +
    ",</p>\n" +
    '    <p style="font-size:14px;color:#555;line-height:1.6;">Good news! Your return request for order <strong>' +
    order.orderNumber +
    ' has been accepted.</strong> The refund will be processed to your UPI account within 3-5 business days.</p>\n' +
    '    <div style="background:#eefaf5;border:1px solid #b9e6d2;border-radius:10px;padding:16px 20px;margin:18px 0;">\n' +
    '      <h3 style="margin:0 0 10px;font-size:15px;color:#12805c;">Refund details</h3>\n' +
    '      <table style="width:100%;font-size:13px;color:#444;border-collapse:collapse;">\n' +
    "        <tr><td style='padding:4px 0;'>Order number</td><td style='text-align:right;font-weight:700;'>" +
    order.orderNumber +
    "</td></tr>\n" +
    "        <tr><td style='padding:4px 0;'>Return reason</td><td style='text-align:right;'>" +
    xmlEscape(returnRequest.reason) +
    "</td></tr>\n" +
    "        <tr><td style='padding:4px 0;'>Order total</td><td style='text-align:right;'>₹" +
    expected.toFixed(2) +
    "</td></tr>\n" +
    "        <tr><td style='padding:4px 0;'>Shipping fee (non-refundable)</td><td style='text-align:right;color:#c0392b;'>- ₹" +
    Number(returnRequest.shippingFee || 0).toFixed(2) +
    "</td></tr>\n" +
    "        <tr><td style='padding:4px 0;'>Extra deductions</td><td style='text-align:right;color:#c0392b;'>- ₹" +
    deduction.toFixed(2) +
    "</td></tr>\n" +
    "        <tr><td style='padding:4px 0;'>Amount to be refunded</td><td style='text-align:right;font-size:16px;font-weight:800;color:#12805c;'>₹" +
    refund.toFixed(2) +
    "</td></tr>\n" +
    "        <tr><td style='padding:4px 0;'>Refund method</td><td style='text-align:right;'>UPI" +
    (returnRequest.upiId ? " (" + xmlEscape(returnRequest.upiId) + ")" : "") +
    "</td></tr>\n" +
    (returnRequest.adminNote
      ? "        <tr><td style='padding:4px 0;'>Note</td><td style='text-align:right;'>" +
        xmlEscape(returnRequest.adminNote) +
        "</td></tr>\n"
      : "") +
    "      </table>\n" +
    "    </div>\n" +
    '    <p style="font-size:13px;color:#777;line-height:1.6;">If you have any questions about this refund, just reply to this email or reach us on Telegram at @Tom_andrew72.</p>\n' +
    '    <a href="' +
    seoSiteUrl +
    '/account" style="display:block;text-align:center;background:#12805c;color:#fff;text-decoration:none;padding:14px;border-radius:999px;font-size:14px;font-weight:700;">Track my return</a>\n' +
    "  </div>\n" +
    "</div>";

  await transporter.sendMail({
    from: '"DEALROOT Beauty" <' + process.env.EMAIL_USER + ">",
    to: customerEmail,
    subject: "✅ Refund request has been accepted — " + order.orderNumber,
    html,
  });
}

async function sendRefundRejectedEmail(returnRequest, order, customerEmail) {
  if (process.env.ORDER_STATUS_EMAIL_DRY_RUN === "true") {
    console.log("[dry-run] Refund rejected email → " + order.orderNumber);
    return;
  }

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#fff;">\n' +
    '  <div style="background:#c0392b;padding:22px 28px;text-align:center;">\n' +
    '    <h1 style="color:#fff;margin:0;font-size:20px;">DEALROOT BEAUTY</h1>\n' +
    '    <p style="color:#fbdcd7;margin:6px 0 0;font-size:13px;">Return request update</p>\n' +
    "  </div>\n" +
    '  <div style="padding:28px;">\n' +
    '    <p style="font-size:14px;color:#333;">Hi ' +
    xmlEscape(order.customer?.name || "there") +
    ",</p>\n" +
    '    <p style="font-size:14px;color:#555;line-height:1.6;">We are sorry, but your return request for order <strong>' +
    order.orderNumber +
    " could not be approved.</p>\n" +
    '    <div style="background:#fdf0ee;border:1px solid #f2c4bd;border-radius:10px;padding:16px 20px;margin:18px 0;">\n' +
    '      <h3 style="margin:0 0 10px;font-size:15px;color:#c0392b;">Why?</h3>\n' +
    '      <p style="font-size:13px;color:#555;line-height:1.6;margin:0;">' +
    xmlEscape(returnRequest.rejectionReason || "Your request did not qualify for a return.") +
    "</p>\n" +
    "    </div>\n" +
    '    <p style="font-size:13px;color:#777;line-height:1.6;">If you believe this is a mistake, please contact us at dealroot.store@gmail.com or @Tom_andrew72 on Telegram and we will look into it.</p>\n' +
    "  </div>\n" +
    "</div>";

  await transporter.sendMail({
    from: '"DEALROOT Beauty" <' + process.env.EMAIL_USER + ">",
    to: customerEmail,
    subject: "❌ Return request update — " + order.orderNumber,
    html,
  });
}

// Customer: file a return/refund request (within 7 days, with photos/video + UPI).
app.post(
  "/api/returns",
  requireUser,
  returnUpload.fields([
    { name: "images", maxCount: 5 },
    { name: "video", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const orderId = String(req.body?.orderId || "").trim();
      const reason = String(req.body?.reason || "").trim();
      const description = String(req.body?.description || "").trim();
      const upiId = String(req.body?.upiId || "").trim();

      if (!orderId) {
        return res.status(400).json({ success: false, message: "Order is required" });
      }
      if (!reason || !RETURN_REASONS.includes(reason)) {
        return res.status(400).json({ success: false, message: "Please choose a valid return reason" });
      }

      const order = await Order.findOne({ _id: orderId, user: req.user.userId });
      if (!order) {
        return res.status(404).json({ success: false, message: "Order not found" });
      }
      if (order.orderStatus === "cancelled") {
        return res.status(400).json({ success: false, message: "Cancelled orders cannot be returned" });
      }

      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      const placedAt = new Date(order.createdAt || Date.now()).getTime();
      if (Date.now() - placedAt > sevenDays) {
        return res.status(400).json({
          success: false,
          message: "The 7-day return window has expired. Please contact support.",
        });
      }

      const existing = await ReturnRequest.findOne({
        order: order._id,
        status: { $in: ["pending", "approved"] },
      });
      if (existing) {
        return res.status(400).json({
          success: false,
          message: "A return request already exists for this order.",
        });
      }

      // Upload return photos + video to Cloudinary.
      const images = [];
      const files = req.files || {};
      for (const file of files.images || []) {
        try {
          const url = await uploadReturnFile(file.buffer, false);
          if (url) images.push(url);
        } catch (error) {
          console.error("Return image upload failed:", error.message);
        }
      }

      let video = "";
      const videoFile = (files.video || [])[0];
      if (videoFile) {
        try {
          video = await uploadReturnFile(videoFile.buffer, true);
        } catch (error) {
          console.error("Return video upload failed:", error.message);
        }
      }

      const user = await User.findById(req.user.userId);
      const customerEmail =
        String(order.customer?.email || "").trim() || user?.email || "";

      const returnRequest = await ReturnRequest.create({
        user: req.user.userId,
        order: order._id,
        orderNumber: order.orderNumber,
        items: (order.items || []).map((item) => ({
          product: item.product,
          title: item.title,
          quantity: item.quantity,
          price: item.price,
        })),
        reason,
        description,
        images,
        video,
        upiId,
        expectedAmount: Number(order.totalAmount || 0),
        shippingFee: Number(order.deliveryFee || 0),
        refundableAmount: Math.max(
          0,
          Number(order.totalAmount || 0) - Number(order.deliveryFee || 0)
        ),
      });

      // Emails: customer confirmation + owner notification.
      if (customerEmail) {
        sendRefundAppliedEmail(returnRequest, order, customerEmail).catch((e) =>
          console.error("Refund applied email failed:", e.message)
        );
      }
      if (process.env.ADMIN_EMAIL) {
        transporter
          .sendMail({
            from: '"DEALROOT Beauty" <' + process.env.EMAIL_USER + ">",
            to: process.env.ADMIN_EMAIL,
            subject: "🔄 New return request — " + order.orderNumber,
            html:
              '<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;"><h2 style="color:#e21c48;">New return request</h2>' +
              '<p>Order: <b>' +
              order.orderNumber +
              "</b></p><p>Reason: " +
              xmlEscape(reason) +
              "</p><p>Description: " +
              xmlEscape(description || "-") +
              "</p><p>Order total: ₹" +
              Number(order.totalAmount || 0).toFixed(2) +
              "</p><p>Shipping fee (non-refundable): -₹" +
              Number(order.deliveryFee || 0).toFixed(2) +
              "</p><p>Refundable after approval: ₹" +
              Math.max(0, Number(order.totalAmount || 0) - Number(order.deliveryFee || 0)).toFixed(2) +
              "</p><p>UPI: " +
              xmlEscape(upiId || "-") +
              '</p><p>Photos: ' +
              (images.length ? images.map((u) => '<a href="' + u + '">view</a>').join(" | ") : "none") +
              (video ? ' | <a href="' + video + '">video</a>' : "") +
              '</p><p>Review it in the admin panel: <a href="' +
              seoSiteUrl +
              '/#admin">DealRoot Admin</a></p></div>',
          })
          .catch((e) => console.error("Owner return email failed:", e.message));
      }

      res.json({
        success: true,
        message: "Return request submitted. We will review it within 1-2 days.",
        returnRequest,
      });
    } catch (error) {
      console.error("Return request failed:", error.message);
      res.status(500).json({ success: false, message: error.message || "Could not submit return request" });
    }
  }
);

// Customer: my return requests.
app.get("/api/returns/my", requireUser, async (req, res) => {
  try {
    const returns = await ReturnRequest.find({ user: req.user.userId })
      .sort({ requestedAt: -1 })
      .limit(20);
    res.json({ success: true, returns });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load returns" });
  }
});

// Admin: all return requests.
app.get("/api/returns", requireAdmin, async (req, res) => {
  try {
    const returns = await ReturnRequest.find()
      .sort({ requestedAt: -1 })
      .limit(100)
      .populate("order", "orderNumber totalAmount customer");
    res.json({ success: true, returns });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load returns" });
  }
});

// Admin: approve a return with deduction + final refund amount.
app.post("/api/returns/:id/approve", requireAdmin, async (req, res) => {
  try {
    const deductionAmount = Math.max(0, Number(req.body?.deductionAmount) || 0);
    const refundAmount = Math.max(0, Number(req.body?.refundAmount) || 0);
    const adminNote = String(req.body?.adminNote || "").trim();

    const returnRequest = await ReturnRequest.findById(req.params.id);
    if (!returnRequest) {
      return res.status(404).json({ success: false, message: "Return request not found" });
    }
    if (returnRequest.status !== "pending") {
      return res.status(400).json({ success: false, message: "This request was already processed" });
    }
    if (refundAmount <= 0) {
      return res.status(400).json({ success: false, message: "Refund amount must be greater than 0" });
    }
    const maxRefund =
      Number(
        returnRequest.refundableAmount || returnRequest.expectedAmount || 0
      ) - deductionAmount;
    if (refundAmount > maxRefund) {
      return res.status(400).json({
        success: false,
        message: "Refund cannot exceed the refundable amount (order total minus non-refundable shipping fee) minus the deduction",
      });
    }

    returnRequest.status = "approved";
    returnRequest.deductionAmount = deductionAmount;
    returnRequest.refundAmount = refundAmount;
    returnRequest.adminNote = adminNote;
    returnRequest.processedAt = new Date();
    await returnRequest.save();

    const order = await Order.findById(returnRequest.order);
    const customerEmail =
      String(order?.customer?.email || "").trim() ||
      (returnRequest.user
        ? (await User.findById(returnRequest.user).select("email"))?.email
        : "") ||
      "";

    if (customerEmail) {
      sendRefundApprovedEmail(returnRequest, order, customerEmail).catch((e) =>
        console.error("Refund approved email failed:", e.message)
      );
    }

    res.json({
      success: true,
      message: "Return approved — refund email sent to the customer.",
      returnRequest,
    });
  } catch (error) {
    console.error("Approve return failed:", error.message);
    res.status(500).json({ success: false, message: "Could not approve return" });
  }
});

// Admin: reject a return.
app.post("/api/returns/:id/reject", requireAdmin, async (req, res) => {
  try {
    const rejectionReason = String(req.body?.rejectionReason || "").trim();
    if (!rejectionReason) {
      return res.status(400).json({ success: false, message: "Please add a rejection reason" });
    }

    const returnRequest = await ReturnRequest.findById(req.params.id);
    if (!returnRequest) {
      return res.status(404).json({ success: false, message: "Return request not found" });
    }
    if (returnRequest.status !== "pending") {
      return res.status(400).json({ success: false, message: "This request was already processed" });
    }

    returnRequest.status = "rejected";
    returnRequest.rejectionReason = rejectionReason;
    returnRequest.processedAt = new Date();
    await returnRequest.save();

    const order = await Order.findById(returnRequest.order);
    const customerEmail =
      String(order?.customer?.email || "").trim() ||
      (returnRequest.user
        ? (await User.findById(returnRequest.user).select("email"))?.email
        : "") ||
      "";

    if (customerEmail) {
      sendRefundRejectedEmail(returnRequest, order, customerEmail).catch((e) =>
        console.error("Refund rejected email failed:", e.message)
      );
    }

    res.json({
      success: true,
      message: "Return rejected — the customer has been notified.",
      returnRequest,
    });
  } catch (error) {
    console.error("Reject return failed:", error.message);
    res.status(500).json({ success: false, message: "Could not reject return" });
  }
});

// ===================== DEALROOT TRYOUTS =====================
const tryoutApplicationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true },
    phone: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    previousProgram: { type: String, trim: true },
    otherProgram: { type: String, trim: true },
    reason: { type: String, default: "" },
    status: {
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
);

const TryoutApplication = mongoose.model(
  "TryoutApplication",
  tryoutApplicationSchema
);

// Customer: apply for the Tryout program (one active application at a time).
app.post("/api/tryouts/apply", requireUser, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const phone = String(req.body?.phone || "").replace(/\D/g, "").slice(0, 10);
    const city = String(req.body?.city || "").trim();
    const state = String(req.body?.state || "").trim();
    const pincode = String(req.body?.pincode || "").replace(/\D/g, "").slice(0, 6);
    const previousProgram = String(req.body?.previousProgram || "").trim();
    const otherProgram = String(req.body?.otherProgram || "").trim();
    const reason = String(req.body?.reason || "").trim();

    if (name.length < 2) {
      return res.status(400).json({ success: false, message: "Please enter your full name" });
    }
    if (phone.length !== 10) {
      return res.status(400).json({ success: false, message: "Please enter a valid 10-digit mobile number" });
    }
    if (pincode.length !== 6) {
      return res.status(400).json({ success: false, message: "Please enter a valid 6-digit pincode" });
    }
    if (previousProgram === "Other" && !otherProgram) {
      return res.status(400).json({ success: false, message: "Please tell us the name of the other program" });
    }
    const TRYOUT_PROGRAMS = ["Freekamaal", "Trybox", "OPA", "Other"];
    if (previousProgram && !TRYOUT_PROGRAMS.includes(previousProgram)) {
      return res.status(400).json({ success: false, message: "Please select a valid option for the previous program" });
    }

    const existing = await TryoutApplication.findOne({
      user: req.user.userId,
      status: { $in: ["pending", "approved"] },
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message:
          existing.status === "approved"
            ? "You are already an approved Tryout member"
            : "Your Tryout application is already under review",
      });
    }

    // Allow re-applying after a rejection.
    if (req.body?.replaceRejected) {
      await TryoutApplication.deleteMany({
        user: req.user.userId,
        status: "rejected",
      });
    }

    const user = await User.findById(req.user.userId).select("email");

    const application = await TryoutApplication.create({
      user: req.user.userId,
      name,
      email: user?.email || "",
      phone,
      city,
      state,
      pincode,
      previousProgram,
      otherProgram,
      reason,
    });

    // Notify the owner about the new application with the full form details.
    if (process.env.ADMIN_EMAIL) {
      if (process.env.ORDER_STATUS_EMAIL_DRY_RUN === "true") {
        console.log("[dry-run] Tryout owner email → " + name);
      } else {
      const prevLabel =
        previousProgram === "Other"
          ? "Other (" + (otherProgram || "-") + ")"
          : previousProgram || "-";
      transporter
        .sendMail({
          from: '"DEALROOT Beauty" <' + process.env.EMAIL_USER + ">",
          to: process.env.ADMIN_EMAIL,
          subject: "📝 New Tryout application — " + name,
          html:
            '<div style="font-family:Arial;padding:30px;max-width:620px;margin:auto">' +
            '<h2 style="color:#1f2a4d;margin:0 0 6px">New Dealroot Tryouts Application</h2>' +
            '<p style="color:#6b7280;margin:0 0 18px">A customer just applied for the Tryout program. Details below:</p>' +
            '<table style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.6">' +
            '<tr><td style="padding:8px 10px;background:#f4f1ff;font-weight:bold;width:160px">Name</td><td style="padding:8px 10px">' + xmlEscape(name) + "</td></tr>" +
            '<tr><td style="padding:8px 10px;background:#f4f1ff;font-weight:bold">Email</td><td style="padding:8px 10px">' + xmlEscape(user?.email || "-") + "</td></tr>" +
            '<tr><td style="padding:8px 10px;background:#f4f1ff;font-weight:bold">Phone</td><td style="padding:8px 10px">' + xmlEscape(phone || "-") + "</td></tr>" +
            '<tr><td style="padding:8px 10px;background:#f4f1ff;font-weight:bold">City</td><td style="padding:8px 10px">' + xmlEscape(city || "-") + "</td></tr>" +
            '<tr><td style="padding:8px 10px;background:#f4f1ff;font-weight:bold">State</td><td style="padding:8px 10px">' + xmlEscape(state || "-") + "</td></tr>" +
            '<tr><td style="padding:8px 10px;background:#f4f1ff;font-weight:bold">Pincode</td><td style="padding:8px 10px">' + xmlEscape(pincode || "-") + "</td></tr>" +
            '<tr><td style="padding:8px 10px;background:#f4f1ff;font-weight:bold">Tried before</td><td style="padding:8px 10px">' + xmlEscape(prevLabel) + "</td></tr>" +
            '<tr><td style="padding:8px 10px;background:#f4f1ff;font-weight:bold">Reason</td><td style="padding:8px 10px">' + xmlEscape(reason || "-") + "</td></tr>" +
            "</table>" +
            '<p style="margin-top:18px;color:#6b7280;font-size:13px">Review this application from the DealRoot admin panel → Tryouts tab (approve / reject / disqualify).</p>' +
            "</div>",
        })
        .catch((err) => console.error("Tryout owner email failed:", err.message));
      }
    }

    res.json({
      success: true,
      message: "Application submitted — we will review it soon",
      application,
    });
  } catch (error) {
    console.error("Tryout apply failed:", error.message);
    res.status(500).json({ success: false, message: "Could not submit your application" });
  }
});

// Customer: my Tryout application / status.
app.get("/api/tryouts/my", requireUser, async (req, res) => {
  try {
    const application = await TryoutApplication.findOne({
      user: req.user.userId,
    }).sort({ requestedAt: -1 });

    // Only count orders that contain Tryout-exclusive products — normal
    // store orders should not show up in the Tryout dashboard.
    const totalOrders = await Order.countDocuments({
      user: req.user.userId,
      tryoutOrder: true,
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
});

// Admin: all Tryout applications.
app.get("/api/tryouts/applications", requireAdmin, async (req, res) => {
  try {
    const applications = await TryoutApplication.find()
      .sort({ requestedAt: -1 })
      .limit(200);
    res.json({ success: true, applications });
  } catch {
    res.status(500).json({ success: false, message: "Could not load applications" });
  }
});

// Admin: approve a Tryout application.
app.post("/api/tryouts/:id/approve", requireAdmin, async (req, res) => {
  try {
    const application = await TryoutApplication.findById(req.params.id);
    if (!application) {
      return res.status(404).json({ success: false, message: "Application not found" });
    }
    if (application.status === "approved") {
      return res.status(400).json({ success: false, message: "Already approved" });
    }

    application.status = "approved";
    application.processedAt = new Date();
    await application.save();

    res.json({ success: true, message: "Application approved — member can now shop Tryout deals", application });
  } catch {
    res.status(500).json({ success: false, message: "Could not approve application" });
  }
});

// Admin: reject a Tryout application.
app.post("/api/tryouts/:id/reject", requireAdmin, async (req, res) => {
  try {
    const application = await TryoutApplication.findById(req.params.id);
    if (!application) {
      return res.status(404).json({ success: false, message: "Application not found" });
    }

    application.status = "rejected";
    application.processedAt = new Date();
    await application.save();

    res.json({ success: true, message: "Application rejected", application });
  } catch {
    res.status(500).json({ success: false, message: "Could not reject application" });
  }
});

// Admin: disqualify an approved Tryout member (revoke membership).
app.post("/api/tryouts/:id/disqualify", requireAdmin, async (req, res) => {
  try {
    const application = await TryoutApplication.findById(req.params.id);
    if (!application) {
      return res.status(404).json({ success: false, message: "Application not found" });
    }
    if (application.status !== "approved") {
      return res.status(400).json({ success: false, message: "Only approved members can be disqualified" });
    }

    application.status = "disqualified";
    application.processedAt = new Date();
    await application.save();

    res.json({ success: true, message: "Member disqualified — Tryout deals are locked again", application });
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

    // Notify the member that cashback was added to their account.
    if (application.email && process.env.EMAIL_USER) {
      if (process.env.ORDER_STATUS_EMAIL_DRY_RUN === "true") {
        console.log("[dry-run] Tryout cashback email → " + application.email);
      } else {
        transporter
          .sendMail({
            from: '"DEALROOT Beauty" <' + process.env.EMAIL_USER + ">",
            to: application.email,
            subject: "🎉 Cashback added to your account — Dealroot Tryouts",
            html:
              '<div style="font-family:Arial;padding:30px;max-width:620px;margin:auto">' +
              '<h2 style="color:#1f2a4d;margin:0 0 6px">Cashback added to your account! 🎉</h2>' +
              '<p style="color:#6b7280;margin:0 0 18px">Hi ' +
              xmlEscape(application.name || "there") +
              ", we have added cashback to your Dealroot Tryout account.</p>" +
              '<table style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.6">' +
              '<tr><td style="padding:8px 10px;background:#f0fdf4;font-weight:bold;width:160px">Cashback added</td><td style="padding:8px 10px">₹' +
              amount +
              "</td></tr>" +
              (note
                ? '<tr><td style="padding:8px 10px;background:#f0fdf4;font-weight:bold">Note</td><td style="padding:8px 10px">' +
                  xmlEscape(note) +
                  "</td></tr>"
                : "") +
              '<tr><td style="padding:8px 10px;background:#f0fdf4;font-weight:bold">Status</td><td style="padding:8px 10px">Available</td></tr>' +
              '<tr><td style="padding:8px 10px;background:#f0fdf4;font-weight:bold">Total available</td><td style="padding:8px 10px">₹' +
              (application.cashbackAvailable || 0) +
              "</td></tr>" +
              "</table>" +
              '<p style="margin-top:18px;color:#6b7280;font-size:13px">You can view your full cashback summary and history in your Tryout dashboard on dealroot.store.</p>' +
              "</div>",
          })
          .catch((err) =>
            console.error("Tryout cashback member email failed:", err.message)
          );
      }
    }

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

const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB connected");

    startCartRecoveryScheduler();

    try {
      const count = await Category.countDocuments();

      if (count === 0) {
        await Category.insertMany([
          { name: "Makeup", emoji: "💄", color: "#FFE4EC" },
          { name: "Skincare", emoji: "✨", color: "#E4F3FF" },
          { name: "Haircare", emoji: "🧴", color: "#FFF1D8" },
          { name: "Fragrance", emoji: "🌸", color: "#EEE9FF" },
          { name: "Bath & Body", emoji: "🫧", color: "#E2F8F0" },
        ]);
      }
    } catch (error) {
      console.error("Could not seed categories:", error.message);
    }



    app.listen(PORT, () => {
      console.log(`DEALROOT backend running on ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
};

startServer();