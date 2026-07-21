require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:5173",
  })
);
app.use(express.json());

const allowedCategories = [
  "Skincare",
  "Makeup",
  "Haircare",
  "Fragrance",
  "Bath & Body",
];

const productSchema = new mongoose.Schema(
  {
    brand: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    category: {
      type: String,
      required: true,
      enum: allowedCategories,
    },
    price: { type: Number, required: true, min: 0 },
    mrp: { type: Number, required: true, min: 0 },
    rating: { type: Number, default: 4.5, min: 0, max: 5 },
    reviews: { type: Number, default: 0, min: 0 },
    image: { type: String, default: "" },
    badge: { type: String, default: "" },
    stock: { type: Number, default: 20, min: 0 },
    isFeatured: { type: Boolean, default: false },
    marketplaceLinks: [
      {
        platform: { type: String, trim: true },
        url: { type: String, trim: true },
      },
    ],
  },
  { timestamps: true }
);

const Product = mongoose.model("Product", productSchema);

const sanitizeMarketplaceLinks = (links) => {
  if (!Array.isArray(links)) return [];

  return links
    .map((link) => ({
      platform: String(link?.platform || "").trim(),
      url: String(link?.url || "").trim(),
    }))
    .filter(({ platform, url }) => platform && url)
    .slice(0, 3);
};

const starterProducts = [
  {
    brand: "Minimalist",
    title: "2% Hyaluronic Acid Face Serum",
    description: "Hydrating serum for soft and healthy-looking skin.",
    category: "Skincare",
    price: 399,
    mrp: 599,
    rating: 4.7,
    reviews: 1840,
    image:
      "https://images.unsplash.com/photo-1620916566398-39f1143ab7be?auto=format&fit=crop&w=700&q=85",
    badge: "Bestseller",
    stock: 30,
    isFeatured: true,
  },
  {
    brand: "Maybelline",
    title: "Fit Me Matte + Poreless Foundation",
    description: "Lightweight matte foundation with a natural finish.",
    category: "Makeup",
    price: 499,
    mrp: 649,
    rating: 4.6,
    reviews: 2300,
    image:
      "https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?auto=format&fit=crop&w=700&q=85",
    badge: "Top deal",
    stock: 25,
    isFeatured: true,
  },
];

const validateProduct = (product) => {
  const { brand, title, category, price, mrp } = product;

  if (!brand || !title || !category || price === "" || mrp === "") {
    return "Brand, title, category, price and MRP are required";
  }

  if (!allowedCategories.includes(category)) {
    return "Please choose a valid category";
  }

  if (Number(price) < 0 || Number(mrp) < 0) {
    return "Price and MRP cannot be negative";
  }

  if (Number(mrp) < Number(price)) {
    return "MRP cannot be lower than selling price";
  }

  return null;
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

app.get("/api/products", async (req, res) => {
  try {
    const { category, search, featured } = req.query;
    const filter = {};

    if (category && category !== "All") filter.category = category;
    if (featured === "true") filter.isFeatured = true;

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: "i" } },
        { brand: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
      ];
    }

    const products = await Product.find(filter).sort({ createdAt: -1 });

    res.json({
      success: true,
      count: products.length,
      products,
    });
  } catch (error) {
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

app.post("/api/products", async (req, res) => {
  try {
    const validationError = validateProduct(req.body);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const product = await Product.create({
      ...req.body,
      price: Number(req.body.price),
      mrp: Number(req.body.mrp),
      rating: Number(req.body.rating || 4.5),
      reviews: Number(req.body.reviews || 0),
      stock: Number(req.body.stock || 0),
      isFeatured: Boolean(req.body.isFeatured),
      marketplaceLinks: sanitizeMarketplaceLinks(req.body.marketplaceLinks),
    });

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

app.put("/api/products/:id", async (req, res) => {
  try {
    const validationError = validateProduct(req.body);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      {
        ...req.body,
        price: Number(req.body.price),
        mrp: Number(req.body.mrp),
        rating: Number(req.body.rating || 4.5),
        reviews: Number(req.body.reviews || 0),
        stock: Number(req.body.stock || 0),
        isFeatured: Boolean(req.body.isFeatured),
        marketplaceLinks: sanitizeMarketplaceLinks(req.body.marketplaceLinks),
      },
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

app.patch("/api/products/:id/stock", async (req, res) => {
  try {
    const stock = Number(req.body.stock);

    if (!Number.isFinite(stock) || stock < 0) {
      return res.status(400).json({
        success: false,
        message: "Stock must be a valid positive number",
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

app.delete("/api/products/:id", async (req, res) => {
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

const seedProducts = async () => {
  const count = await Product.countDocuments();

  if (count === 0) {
    await Product.insertMany(starterProducts);
    console.log("Starter products added to MongoDB");
  }
};

const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB connected");

    await seedProducts();

    app.listen(PORT, () => {
      console.log(`DEALROOT backend running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
};

startServer();